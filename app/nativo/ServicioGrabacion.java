package uk.legaxia.estudia;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;

import java.io.File;

/**
 * Graba la clase en primer plano para que Android no mate el proceso
 * cuando el usuario apaga la pantalla o cambia de app.
 *
 * Formato: AAC en contenedor M4A, 32 kbps mono. Una clase de dos horas
 * pesa unos 29 MB — sube rápido incluso con datos móviles, y ffmpeg lo
 * convierte a WAV 16 kHz en el VPS sin pérdida relevante para Vosk.
 */
public class ServicioGrabacion extends Service {

    public static final String CANAL = "grabacion_clase";
    public static final String ACCION_INICIAR = "iniciar";
    public static final String ACCION_DETENER = "detener";

    private static MediaRecorder grabadora;
    private static PowerManager.WakeLock candado;
    private static long inicioMs = 0;
    private static String rutaActual = null;
    private static boolean pausada = false;

    public static boolean estaGrabando() { return grabadora != null; }
    public static boolean estaPausada()  { return pausada; }

    /** Pico de amplitud desde la última consulta, normalizado a 0–1. */
    public static double getNivel() {
        if (grabadora == null || pausada) return 0;
        try {
            return Math.min(1.0, grabadora.getMaxAmplitude() / 12000.0);
        } catch (Exception e) {
            return 0;
        }
    }

    public static String  getRuta()      { return rutaActual; }
    public static long    getSegundos()  {
        return inicioMs == 0 ? 0 : (SystemClock.elapsedRealtime() - inicioMs) / 1000;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String accion = intent != null ? intent.getAction() : null;

        if (ACCION_DETENER.equals(accion)) {
            detener();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        crearCanal();
        startForeground(1, construirNotificacion("Grabando la clase"));

        try {
            iniciar();
        } catch (Exception e) {
            android.util.Log.e("EstudiaPro", "No se pudo iniciar la grabación", e);
            stopForeground(true);
            stopSelf();
        }
        return START_STICKY;
    }

    private void iniciar() throws Exception {
        if (grabadora != null) return;

        File dir = new File(getFilesDir(), "clases");
        if (!dir.exists()) dir.mkdirs();
        File destino = new File(dir, "clase_" + System.currentTimeMillis() + ".m4a");
        rutaActual = destino.getAbsolutePath();

        grabadora = Build.VERSION.SDK_INT >= 31
                ? new MediaRecorder(this)
                : new MediaRecorder();

        // VOICE_RECOGNITION deja pasar la señal sin el procesamiento agresivo
        // de VOICE_COMMUNICATION, que recorta al hablante lejano en un aula.
        grabadora.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION);
        grabadora.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        grabadora.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        grabadora.setAudioChannels(1);
        grabadora.setAudioSamplingRate(16000);
        grabadora.setAudioEncodingBitRate(32000);
        grabadora.setOutputFile(rutaActual);
        grabadora.prepare();
        grabadora.start();

        inicioMs = SystemClock.elapsedRealtime();
        pausada = false;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        candado = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EstudiaPro:clase");
        candado.acquire(4 * 60 * 60 * 1000L);   // tope de 4 horas
    }

    public static void detener() {
        if (grabadora != null) {
            try { grabadora.stop(); } catch (Exception ignored) {}
            try { grabadora.release(); } catch (Exception ignored) {}
            grabadora = null;
        }
        if (candado != null && candado.isHeld()) candado.release();
        candado = null;
        inicioMs = 0;
        pausada = false;
    }

    public static void pausar() {
        if (grabadora != null && !pausada && Build.VERSION.SDK_INT >= 24) {
            grabadora.pause();
            pausada = true;
        }
    }

    public static void reanudar() {
        if (grabadora != null && pausada && Build.VERSION.SDK_INT >= 24) {
            grabadora.resume();
            pausada = false;
        }
    }

    private void crearCanal() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel c = new NotificationChannel(
                CANAL, "Grabación de clases", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Aviso mientras se graba una clase");
        c.setShowBadge(false);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
    }

    private Notification construirNotificacion(String texto) {
        Intent abrir = new Intent(this, MainActivity.class);
        abrir.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pAbrir = PendingIntent.getActivity(this, 0, abrir,
                PendingIntent.FLAG_IMMUTABLE);

        Intent parar = new Intent(this, ServicioGrabacion.class).setAction(ACCION_DETENER);
        PendingIntent pParar = PendingIntent.getService(this, 1, parar,
                PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CANAL)
                .setContentTitle("EstudiaPro")
                .setContentText(texto)
                .setSmallIcon(android.R.drawable.presence_audio_online)
                .setContentIntent(pAbrir)
                .addAction(0, "Detener", pParar)
                .setOngoing(true)
                .setUsesChronometer(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onDestroy() {
        detener();
        super.onDestroy();
    }
}
