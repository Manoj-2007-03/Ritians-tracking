package com.ritians.transport;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;
import java.util.Random;

/**
 * Renders the premium RITIANS Transport tray notification, AND forwards the
 * raw data payload into the WebView (via MainActivity) so the in-app
 * foreground toast fires too.
 *
 * NOTE: this app also declares @capacitor/push-notifications' own
 * MessagingService for the same com.google.firebase.MESSAGING_EVENT intent.
 * In practice Android does not reliably fan a single FCM message out to
 * multiple FirebaseMessagingService classes — only one wins, and it's this
 * one. So this class does NOT assume Capacitor's service will also fire;
 * it owns both the tray notification AND the in-app JS delivery.
 *
 * IMPORTANT: this only fires reliably in every app state (foreground,
 * background, killed) if the backend sends a DATA-ONLY message (no top-level
 * "notification" key). If a "notification" key is present, Android bypasses
 * this class entirely while the app is backgrounded/killed and shows a bare
 * system notification instead. See updated backend/notifications.js.
 */
public class RtMessagingService extends FirebaseMessagingService {

    private static final String CHANNEL_ID = "bus_updates";
    private static final String CHANNEL_NAME = "Bus Updates";

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        Map<String, String> data = remoteMessage.getData();
        if (data == null || data.isEmpty()) return;

        String title = data.get("title");
        String body = data.get("body");
        String liveUrl = data.get("liveUrl");
        String vehicleId = data.get("vehicleId");

        if (title == null) title = "RITIANS Transport";
        if (body == null) body = "";

        // Forward to the WebView first (no-ops silently if the app isn't
        // currently in the foreground) — this is what makes the in-app
        // toast.js premium toast appear while the app is open, mirroring
        // what Capacitor's own 'pushNotificationReceived' listener would
        // have done if its service had actually received the message.
        try {
            JSONObject json = new JSONObject();
            for (Map.Entry<String, String> entry : data.entrySet()) {
                json.put(entry.getKey(), entry.getValue());
            }
            MainActivity.deliverPushToWebView(json.toString());
        } catch (Exception ignored) {
            // Never let a bad payload stop the tray notification below.
        }

        ensureChannel();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_bus)
                .setColor(ContextCompat.getColor(this, R.color.notif_accent))
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);

        // Large icon (circular RITIANS badge)
        builder.setLargeIcon(BitmapFactory.decodeResource(getResources(), R.drawable.notif_large_icon));

        // Expanded big-picture banner
        builder.setStyle(
                new NotificationCompat.BigPictureStyle()
                        .bigPicture(BitmapFactory.decodeResource(getResources(), R.drawable.notif_big_picture))
                        .bigLargeIcon((android.graphics.Bitmap) null)
                        .setSummaryText(body)
        );

        // Tapping the notification body opens the app straight to the live map
        if (liveUrl != null) {
            builder.setContentIntent(buildLiveTrackingIntent(liveUrl, 100));
            // "View Live" action button - same deep link, one tap from the tray
            builder.addAction(0, "View Live", buildLiveTrackingIntent(liveUrl, 200));
        }

        int notificationId = vehicleId != null ? vehicleId.hashCode() : new Random().nextInt();
        NotificationManagerCompat.from(this).notify(notificationId, builder.build());
    }

    private PendingIntent buildLiveTrackingIntent(String liveUrl, int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("live_url", liveUrl);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Bus started and arrival alerts");
            channel.setLightColor(ContextCompat.getColor(this, R.color.notif_accent));
            manager.createNotificationChannel(channel);
        }
    }
}