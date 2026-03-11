package ai.openpocket.ime;

import android.inputmethodservice.InputMethodService;
import android.view.View;
import android.view.inputmethod.InputConnection;
import android.widget.FrameLayout;

/**
 * Minimal InputMethodService that exposes a programmatic text-commit API
 * for OpenPocket automation.  No visible keyboard is shown; all input
 * arrives through {@link InputReceiver} broadcasts sent via ADB.
 *
 * The keyboard view is a 1-pixel transparent strip so it does not
 * obscure the screen when momentarily activated during text injection.
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
    public View onCreateInputView() {
        View v = new View(this);
        v.setBackgroundColor(0x00000000);
        v.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 1));
        return v;
    }

    @Override
    public void onComputeInsets(Insets outInsets) {
        super.onComputeInsets(outInsets);
        // Report zero visible height so the app content is not pushed up.
        outInsets.contentTopInsets = outInsets.visibleTopInsets;
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
