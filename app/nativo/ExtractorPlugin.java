package uk.legaxia.estudia;

import android.annotation.SuppressLint;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Saca los subtítulos de un video de YouTube abriéndolo en un WebView.
 *
 * Es la misma técnica que usa el navegador Brave para su función de resumir
 * videos: no le pide nada a ninguna API. Deja que YouTube cargue la página
 * normalmente y después lee la variable `ytplayer` que el propio reproductor
 * dejó en memoria, con las pistas de subtítulos ya adentro.
 *
 * Funciona donde fallan los otros métodos porque no hay nada que detectar:
 * es una página de YouTube cargándose como cualquier otra.
 */
@CapacitorPlugin(name = "Extractor")
public class ExtractorPlugin extends Plugin {

    private static final int TIMEOUT_MS = 90000;

    private String ultimoEstado = "(sin datos)";
    private String ultimoTitulo = "";

    /** Deja un texto seguro para meterlo dentro de un JSON armado a mano. */
    private static String escapar(String t) {
        if (t == null) return "";
        return t.replace("\\", "").replace("\"", "'").replace("\n", " ").trim();
    }

    private static final String UA_ESCRITORIO =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    /**
     * Corre dentro de la página, ya con todo cargado. Busca las pistas donde
     * las deja YouTube (dos lugares posibles según la versión del reproductor),
     * baja la que corresponda y devuelve el texto plano.
     */
    /**
     * Corre dentro de la página. Dos estrategias, en orden:
     *
     *  1. Leer las pistas de `ytplayer` y bajar el texto por URL. Rápido,
     *     pero YouTube devuelve cuerpo vacío cuando la pista exige el token
     *     que solo genera el reproductor real.
     *
     *  2. Abrir el panel de transcripción de la propia interfaz y leer el
     *     texto de la pantalla. Es lo que haría una persona con el dedo, así
     *     que YouTube no lo puede bloquear sin romper su propio sitio.
     *
     * Se reinvoca cada 500 ms; el estado vive en window.__ep para no repetir
     * trabajo entre llamadas.
     */
    private static final String GUION =
        "(function(){" +
        "  if (!window.__ep) window.__ep = { fase:'inicio', reporte:[], idiomas:'' };" +
        "  var E = window.__ep;" +
        "  var titulo = function(){" +
        "    return (document.title||'').replace(/ - YouTube$/,'').trim();" +
        "  };" +
        "  function entregar(texto, idioma, via){" +
        "    AndroidPuente.recibir(JSON.stringify({" +
        "      texto: texto, idioma: idioma, idiomas: E.idiomas," +
        "      titulo: titulo(), via: via" +
        "    }));" +
        "  }" +
        "  function limpiar(t){ return t.replace(/\\n/g,' ').replace(/\\s{2,}/g,' ').trim(); }" +

        // ── Estrategia 2: leer el panel de transcripción de la interfaz ──
        "  function porPantalla(){" +
        "    var segs = document.querySelectorAll('ytd-transcript-segment-renderer .segment-text,'" +
        "      + ' ytd-transcript-segment-renderer yt-formatted-string.segment-text,'" +
        "      + ' .ytd-transcript-segment-renderer .segment-text');" +
        "    if (segs.length > 3) {" +
        "      var t = [];" +
        "      for (var i=0;i<segs.length;i++) t.push((segs[i].textContent||'').trim());" +
        "      var texto = limpiar(t.filter(Boolean).join(' '));" +
        "      if (texto.length >= 120) { entregar(texto, 'pantalla', 'dom'); return true; }" +
        "    }" +
        "    return false;" +
        "  }" +
        "  function abrirPanel(){" +
        // Expandir la descripción, que es donde vive el botón
        "    var exp = document.querySelector('#expand, tp-yt-paper-button#expand,'" +
        "      + ' ytd-text-inline-expander #expand');" +
        "    if (exp) { try { exp.click(); } catch(e){} }" +
        // Botón de transcripción: por etiqueta o por texto visible
        "    var bs = document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape button');" +
        "    for (var i=0;i<bs.length;i++){" +
        "      var et = ((bs[i].getAttribute('aria-label')||'') + ' ' + (bs[i].textContent||'')).toLowerCase();" +
        "      if (et.indexOf('transcript') >= 0 || et.indexOf('transcripci') >= 0) {" +
        "        try { bs[i].click(); return true; } catch(e){}" +
        "      }" +
        "    }" +
        "    return false;" +
        "  }" +

        // ── Estrategia 1: pistas de ytplayer ──
        "  function pistas(){" +
        "    try { var t = ytplayer.config.args.raw_player_response.captions" +
        "                 .playerCaptionsTracklistRenderer.captionTracks;" +
        "          if (t && t.length) return t; } catch(e){}" +
        "    try { var t = ytInitialPlayerResponse.captions" +
        "                 .playerCaptionsTracklistRenderer.captionTracks;" +
        "          if (t && t.length) return t; } catch(e){}" +
        "    try { var t = window.ytcfg.data_.PLAYER_VARS.raw_player_response" +
        "                 .captions.playerCaptionsTracklistRenderer.captionTracks;" +
        "          if (t && t.length) return t; } catch(e){}" +
        "    return null;" +
        "  }" +
        "  function extraer(c){" +
        "    var texto = '';" +
        "    if (c.trim().charAt(0) === '{') {" +
        "      try { var d = JSON.parse(c);" +
        "        (d.events||[]).forEach(function(e){" +
        "          (e.segs||[]).forEach(function(s){ texto += s.utf8; });" +
        "        }); } catch(e){}" +
        "    } else {" +
        "      var m = c.match(/<text[^>]*>([\\s\\S]*?)<\\/text>/g) || [];" +
        "      texto = m.map(function(x){" +
        "        return x.replace(/<[^>]+>/g,'')" +
        "                .replace(/&amp;#39;/g, String.fromCharCode(39))" +
        "                .replace(/&amp;quot;/g, String.fromCharCode(34))" +
        "                .replace(/&amp;amp;/g,'&').trim();" +
        "      }).join(' ');" +
        "    }" +
        "    return limpiar(texto);" +
        "  }" +

        // ── Máquina de estados ──
        "  if (E.fase === 'dom') {" +
        "    if (porPantalla()) return 'LISTO';" +
        "    E.intentosDom = (E.intentosDom||0) + 1;" +
        "    if (E.intentosDom % 6 === 0) abrirPanel();" +   // reintentar el clic
        "    if (E.intentosDom > 40) {" +
        "      AndroidPuente.recibir(JSON.stringify({" +
        "        error:'ni por URL ni por pantalla', idiomas:E.idiomas," +
        "        detalle:E.reporte.join(' | '), titulo: titulo()" +
        "      }));" +
        "      return 'LISTO';" +
        "    }" +
        "    return 'ESPERA::panel de transcripción, intento ' + E.intentosDom;" +
        "  }" +
        "  if (E.fase === 'fetch') return 'ESPERA::bajando por URL';" +

        "  var t = pistas();" +
        "  if (!t) {" +
        "    var estado = 'url=' + location.href.slice(0,90)" +
        "      + ' | ytplayer=' + (typeof ytplayer)" +
        "      + ' | ytInitial=' + (typeof ytInitialPlayerResponse)" +
        "      + ' | body=' + ((document.body&&document.body.innerText)||'').length;" +
        "    return 'ESPERA::' + estado;" +
        "  }" +
        "  E.idiomas = t.map(function(x){return x.languageCode}).join(',');" +
        "  var p = t.filter(function(x){return /^en/i.test(x.languageCode)})[0]" +
        "       || t.filter(function(x){return /^es/i.test(x.languageCode)})[0]" +
        "       || t[0];" +
        "  E.fase = 'fetch';" +
        "  var base = p.baseUrl.replace(/&fmt=[^&]*/,'');" +
        "  var formas = [base + '&fmt=json3', base, base + '&fmt=srv3'];" +
        "  (function intento(i){" +
        "    if (i >= formas.length) {" +
        // Las URLs no sirvieron: pasar a leer la pantalla
        "      E.fase = 'dom';" +
        "      E.reporte.push('urls vacías');" +
        "      abrirPanel();" +
        "      return;" +
        "    }" +
        "    fetch(formas[i]).then(function(r){" +
        "      return r.text().then(function(c){ return {c:c, s:r.status}; });" +
        "    }).then(function(o){" +
        "      var texto = extraer(o.c);" +
        "      E.reporte.push('f'+i+':HTTP'+o.s+','+o.c.length+'b');" +
        "      if (texto.length >= 120) { entregar(texto, p.languageCode, 'url'); }" +
        "      else { intento(i+1); }" +
        "    }).catch(function(e){" +
        "      E.reporte.push('f'+i+':'+e.message); intento(i+1);" +
        "    });" +
        "  })(0);" +
        "  return 'ESPERA::probando URLs';" +
        "})()";

    @PluginMethod
    public void subtitulos(final PluginCall call) {
        final String video = call.getString("video");
        if (video == null || !video.matches("[\\w-]{11}")) {
            call.reject("ID de video inválido");
            return;
        }

        getActivity().runOnUiThread(() -> abrir(call, video));
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private void abrir(final PluginCall call, final String video) {
        final WebView web = new WebView(getContext());
        final AtomicBoolean resuelto = new AtomicBoolean(false);
        final Handler mano = new Handler(Looper.getMainLooper());

        // Envuelve la resolución para que solo ocurra una vez y siempre
        // libere el WebView, sin importar por dónde termine.
        final java.util.function.BiConsumer<String, String> terminar = (ok, error) -> {
            if (!resuelto.compareAndSet(false, true)) return;
            mano.post(() -> {
                try { web.stopLoading(); web.destroy(); } catch (Exception ignored) {}
                if (error != null) {
                    call.reject(error);
                } else {
                    JSObject r = new JSObject();
                    r.put("json", ok);
                    call.resolve(r);
                }
            });
        };

        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setUserAgentString(UA_ESCRITORIO);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        CookieManager.getInstance().setCookie("https://www.youtube.com", "CONSENT=YES+cb");
        CookieManager.getInstance().setCookie("https://www.youtube.com", "SOCS=CAI");

        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void recibir(String json) {
                terminar.accept(json, null);
            }
        }, "AndroidPuente");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                // ytplayer no existe apenas termina de cargar el HTML: el
                // reproductor lo llena unos instantes después. Se reintenta.
                sondear(web, 0, terminar);
            }
        });

        // Red de seguridad: si el video no carga o la página se queda pensando
        mano.postDelayed(() -> terminar.accept(null,
            "YouTube tardó demasiado en cargar el video."), TIMEOUT_MS);

        web.loadUrl("https://www.youtube.com/watch?v=" + video + "&bpctr=9999999999&hl=en");
    }

    private void sondear(final WebView web, final int intento,
                         final java.util.function.BiConsumer<String, String> terminar) {
        if (intento > 120) {  // 120 × 500 ms = 60 segundos
            // Sin subtítulos, pero el título sirve para investigar el tema
            terminar.accept("{\"error\":\"sin subtítulos\",\"titulo\":\"" +
                escapar(ultimoTitulo) + "\",\"detalle\":\"" + escapar(ultimoEstado) + "\"}", null);
            return;
        }
        web.evaluateJavascript(GUION, valor -> {
            if (valor != null && valor.contains("ESPERA")) {
                // Guardar el estado de la página por si se agota el tiempo
                int i = valor.indexOf("ESPERA::");
                if (i >= 0) ultimoEstado = valor.substring(i + 8).replace("\\\"", "").replace("\"", "");
                web.evaluateJavascript(
                    "(document.title||'').replace(/ - YouTube$/,'').trim()",
                    t -> { if (t != null && t.length() > 2)
                             ultimoTitulo = t.replace("\"", "").trim(); });
                new Handler(Looper.getMainLooper())
                    .postDelayed(() -> sondear(web, intento + 1, terminar), 500);
            }
            // 'BAJANDO' significa que ya arrancó el fetch; la respuesta
            // llegará por AndroidPuente.recibir
        });
    }
}
