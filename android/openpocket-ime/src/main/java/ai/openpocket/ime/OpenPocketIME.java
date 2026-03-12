package ai.openpocket.ime;

import android.inputmethodservice.InputMethodService;
import android.view.View;
import android.view.inputmethod.InputConnection;

/**
 * Invisible InputMethodService for OpenPocket automation.
 *
 * No keyboard window is ever shown — {@link #onEvaluateInputViewShown()}
 * returns false so the system never creates a visible keyboard surface.
 * The service still binds to the focused input field, providing a valid
 * {@link InputConnection} for text injection via {@link InputReceiver}
 * broadcasts sent from ADB.
 */
public class OpenPocketIME extends InputMethodService {

    static volatile OpenPocketIME sInstance;

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
    }

    @Override
    public void onDestroy() {
        sInstance = null;
        super.onDestroy();
    }

    @Override
    public boolean onEvaluateInputViewShown() {
        // Never show a keyboard window. The IME service stays connected
        // to the focused input field so getCurrentInputConnection() works,
        // but no visual surface is created — preventing black-screen artifacts.
        return false;
    }

    @Override
    public View onCreateInputView() {
        // Returning null as an extra safety measure; onEvaluateInputViewShown
        // already prevents this from being called, but defensive coding.
        return null;
    }

    void commitText(String text) {
        InputConnection ic = getCurrentInputConnection();
        if (ic != null && text != null) {
            ic.commitText(text, 1);
        }
    }

    void clearText() {
        InputConnection ic = getCurrentInputConnection();
        if (ic != null) {
            ic.performContextMenuAction(android.R.id.selectAll);
            ic.commitText("", 1);
        }
    }
}
