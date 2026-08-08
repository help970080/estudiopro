package uk.legaxia.estudia;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Expone la grabadora nativa y la subida al VPS como métodos llamables
 * desde el WebView: Grabadora.iniciar(), .detener(), .estado(), .subir().
 *
 * La subida va en streaming desde el archivo, no cargando todo en RAM:
 * una clase larga tumbaría el WebView si se pasara como base64.
 */
@CapacitorPlugin(
    name = "Grabadora",
    permissions = {
        @Permission(alias = "microfono", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "avisos",    strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class GrabadoraPlugin extends Plugin {

    @PluginMethod
    public void iniciar(PluginCall call) {
        if (getPermissionState("microfono") != PermissionState.GRANTED) {
            requestPermissionForAlias("microfono", call, "trasPermiso");
            return;
        }
        arrancar(call);
    }

    @PermissionCallback
    private void trasPermiso(PluginCall call) {
        if (getPermissionState("microfono") != PermissionState.GRANTED) {
            call.reject("Sin acceso al micrófono no se puede grabar la clase");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("avisos") != PermissionState.GRANTED) {
            requestPermissionForAlias("avisos", call, "trasAvisos");
            return;
        }
        arrancar(call);
    }

    @PermissionCallback
    private void trasAvisos(PluginCall call) {
        // Sin el permiso de notificaciones el servicio sigue corriendo,
        // solo que sin aviso visible. No es motivo para bloquear la grabación.
        arrancar(call);
    }

    private void arrancar(PluginCall call) {
        Intent i = new Intent(getContext(), ServicioGrabacion.class);
        i.setAction(ServicioGrabacion.ACCION_INICIAR);
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
        else getContext().startService(i);

        JSObject r = new JSObject();
        r.put("grabando", true);
        call.resolve(r);
    }

    @PluginMethod
    public void detener(PluginCall call) {
        String ruta = ServicioGrabacion.getRuta();
        long segundos = ServicioGrabacion.getSegundos();

        Intent i = new Intent(getContext(), ServicioGrabacion.class);
        i.setAction(ServicioGrabacion.ACCION_DETENER);
        getContext().startService(i);

        JSObject r = new JSObject();
        r.put("ruta", ruta);
        r.put("segundos", segundos);
        r.put("bytes", ruta != null ? new File(ruta).length() : 0);
        call.resolve(r);
    }

    @PluginMethod
    public void pausar(PluginCall call) {
        ServicioGrabacion.pausar();
        call.resolve();
    }

    @PluginMethod
    public void reanudar(PluginCall call) {
        ServicioGrabacion.reanudar();
        call.resolve();
    }

    @PluginMethod
    public void estado(PluginCall call) {
        JSObject r = new JSObject();
        r.put("grabando", ServicioGrabacion.estaGrabando());
        r.put("pausada", ServicioGrabacion.estaPausada());
        r.put("segundos", ServicioGrabacion.getSegundos());
        r.put("nivel", ServicioGrabacion.getNivel());
        r.put("ruta", ServicioGrabacion.getRuta());
        call.resolve(r);
    }

    /** Lista grabaciones que quedaron en el teléfono sin transcribir. */
    @PluginMethod
    public void pendientes(PluginCall call) {
        File dir = new File(getContext().getFilesDir(), "clases");
        JSArray lista = new JSArray();
        File[] archivos = dir.listFiles();
        if (archivos != null) {
            java.util.Arrays.sort(archivos, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File f : archivos) {
                if (f.length() < 4096) continue;
                JSObject o = new JSObject();
                o.put("ruta", f.getAbsolutePath());
                o.put("bytes", f.length());
                o.put("fecha", f.lastModified());
                lista.put(o);
            }
        }
        JSObject r = new JSObject();
        r.put("archivos", lista);
        call.resolve(r);
    }

    @PluginMethod
    public void borrar(PluginCall call) {
        String ruta = call.getString("ruta");
        if (ruta != null) new File(ruta).delete();
        call.resolve();
    }

    /**
     * Sube el archivo al endpoint /transcribir del VPS como multipart,
     * leyéndolo en bloques de 64 KB y avisando el avance al WebView.
     */
    @PluginMethod
    public void subir(final PluginCall call) {
        final String ruta = call.getString("ruta");
        final String url = call.getString("url");
        final String token = call.getString("token", "");
        final String titulo = call.getString("titulo", "");
        final String materia = call.getString("materia", "");

        if (ruta == null || url == null) {
            call.reject("Falta la ruta del archivo o la URL del servidor");
            return;
        }
        final File archivo = new File(ruta);
        if (!archivo.exists()) {
            call.reject("La grabación ya no está en el teléfono");
            return;
        }

        new Thread(() -> {
            HttpURLConnection con = null;
            final String limite = "----estudia" + System.currentTimeMillis();
            try {
                con = (HttpURLConnection) new URL(url).openConnection();
                con.setDoOutput(true);
                con.setRequestMethod("POST");
                con.setConnectTimeout(30000);
                con.setReadTimeout(30 * 60 * 1000);   // Vosk tarda en clases largas
                con.setRequestProperty("x-app-token", token);
                con.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + limite);
                String campos = campo("titulo", titulo, limite) + campo("materia", materia, limite);
                con.setFixedLengthStreamingMode(
                        cuerpoLargo(campos, archivo.getName(), archivo.length(), limite));

                OutputStream salida = con.getOutputStream();
                salida.write(campos.getBytes("UTF-8"));
                salida.write(cabecera(archivo.getName(), limite).getBytes("UTF-8"));

                FileInputStream in = new FileInputStream(archivo);
                byte[] buf = new byte[65536];
                long enviados = 0, total = archivo.length();
                int leidos, ultimoPct = -1;
                while ((leidos = in.read(buf)) != -1) {
                    salida.write(buf, 0, leidos);
                    enviados += leidos;
                    int pct = (int) (enviados * 100 / total);
                    if (pct != ultimoPct && pct % 2 == 0) {
                        ultimoPct = pct;
                        JSObject ev = new JSObject();
                        ev.put("porcentaje", pct);
                        notifyListeners("avanceSubida", ev);
                    }
                }
                in.close();
                salida.write(("\r\n--" + limite + "--\r\n").getBytes("UTF-8"));
                salida.flush();
                salida.close();

                int codigo = con.getResponseCode();
                InputStream flujo = codigo < 400 ? con.getInputStream() : con.getErrorStream();
                StringBuilder sb = new StringBuilder();
                byte[] b = new byte[8192];
                int n;
                while ((n = flujo.read(b)) != -1) sb.append(new String(b, 0, n, "UTF-8"));
                flujo.close();

                if (codigo >= 400) {
                    call.reject("El servidor de audio respondió " + codigo);
                    return;
                }
                JSObject r = new JSObject();
                r.put("respuesta", sb.toString());
                call.resolve(r);

            } catch (IOException e) {
                call.reject("Se cortó la subida: " + e.getMessage());
            } finally {
                if (con != null) con.disconnect();
            }
        }).start();
    }

    private String cabecera(String nombre, String limite) {
        return "--" + limite + "\r\n"
             + "Content-Disposition: form-data; name=\"audio\"; filename=\"" + nombre + "\"\r\n"
             + "Content-Type: audio/mp4\r\n\r\n";
    }

    /** Campo de texto del multipart (título, materia). */
    private String campo(String nombre, String valor, String limite) {
        return "--" + limite + "\r\n"
             + "Content-Disposition: form-data; name=\"" + nombre + "\"\r\n\r\n"
             + valor + "\r\n";
    }

    private long cuerpoLargo(String campos, String nombre, long tam, String limite) {
        try {
            return campos.getBytes("UTF-8").length
                 + cabecera(nombre, limite).getBytes("UTF-8").length
                 + tam
                 + ("\r\n--" + limite + "--\r\n").getBytes("UTF-8").length;
        } catch (java.io.UnsupportedEncodingException e) {
            throw new RuntimeException(e);
        }
    }
}
