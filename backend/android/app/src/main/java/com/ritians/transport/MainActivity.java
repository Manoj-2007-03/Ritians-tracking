package com.ritians.transport;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;

import java.util.concurrent.atomic.AtomicReference;

import com.getcapacitor.BridgeActivity;
import com.equimaps.capacitor_background_geolocation.BackgroundGeolocation;

public class MainActivity extends BridgeActivity {

    // Tracks the currently-foregrounded activity instance so
    // RtMessagingService can hand push data straight to the WebView. This
    // exists because Android only reliably delivers an FCM message to ONE
    // of the two FirebaseMessagingService classes declared in the manifest
    // (RtMessagingService and Capacitor's own pushnotifications.MessagingService)
    // — RtMessagingService is the one that actually fires, so it can no
    // longer depend on Capacitor's service to relay 'pushNotificationReceived'
    // into JS. This gives it a direct path instead.
    private static final AtomicReference<MainActivity> activeInstance = new AtomicReference<>();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundGeolocation.class);
        super.onCreate(savedInstanceState);
        handleLiveUrlIntent(getIntent());
    }

    @Override
    public void onResume() {
        super.onResume();
        activeInstance.set(this);
    }

    @Override
    public void onPause() {
        activeInstance.compareAndSet(this, null);
        super.onPause();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleLiveUrlIntent(intent);
    }

    // Called by RtMessagingService on every push. Silently does nothing if
    // the app isn't currently in the foreground (activeInstance is null) —
    // background/killed states are already handled by the tray notification.
    public static void deliverPushToWebView(String dataJson) {
        MainActivity activity = activeInstance.get();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            try {
                WebView webView = activity.getBridge().getWebView();
                if (webView == null) return;
                String js = "window.__rtHandleNativePush && window.__rtHandleNativePush(" + dataJson + ");";
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
                // Never let a malformed/unexpected push crash the running app.
            }
        });
    }

    // Navigates the existing Capacitor webview straight to the live tracking
    // page when the app is opened from a "Bus Started" notification tap or
    // the "View Live" action button. Falls back silently if anything's off
    // so this never blocks normal app launch.
    private void handleLiveUrlIntent(Intent intent) {
        if (intent == null) return;
        String liveUrl = intent.getStringExtra("live_url");
        if (liveUrl == null || liveUrl.isEmpty()) return;

        try {
            WebView webView = getBridge().getWebView();
            String currentUrl = webView.getUrl();
            if (currentUrl == null) return;

            Uri current = Uri.parse(currentUrl);
            String origin = current.getScheme() + "://" + current.getHost()
                    + (current.getPort() != -1 ? ":" + current.getPort() : "");

            String target = liveUrl.startsWith("/") ? origin + liveUrl : origin + "/" + liveUrl;
            webView.loadUrl(target);
        } catch (Exception ignored) {
            // Never let a bad deep link crash app launch.
        }
    }
}
