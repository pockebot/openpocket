package ai.openpocket.ime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;

import java.nio.charset.StandardCharsets;

/**
 * Receives text-input broadcasts from ADB and forwards them to the
 * active {@link OpenPocketIME} instance.
 *
 * Supported actions (sent via {@code am broadcast}):
 * <ul>
 *   <li>{@code ai.openpocket.ime.COMMIT_TEXT --es text "hello"}</li>
 *   <li>{@code ai.openpocket.ime.COMMIT_B64 --es msg "<base64>"}</li>
 *   <li>{@code ai.openpocket.ime.CLEAR}</li>
 * </ul>
 */
public class InputReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }
        OpenPocketIME ime = OpenPocketIME.sInstance;
        if (ime == null) {
            return;
        }

        switch (intent.getAction()) {
            case "ai.openpocket.ime.COMMIT_TEXT": {
                String text = intent.getStringExtra("text");
                if (text != null) {
                    ime.commitText(text);
                }
                break;
            }
            case "ai.openpocket.ime.COMMIT_B64": {
                String b64 = intent.getStringExtra("msg");
                if (b64 != null) {
                    try {
                        byte[] decoded = Base64.decode(b64, Base64.DEFAULT);
                        ime.commitText(new String(decoded, StandardCharsets.UTF_8));
                    } catch (Exception ignored) {
                        // Malformed base64 — silently drop.
                    }
                }
                break;
            }
            case "ai.openpocket.ime.CLEAR": {
                ime.clearText();
                break;
            }
            default:
                break;
        }
    }
}
