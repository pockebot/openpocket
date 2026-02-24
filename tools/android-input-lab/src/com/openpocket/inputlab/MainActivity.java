package com.openpocket.inputlab;

import android.app.Activity;
import android.os.Bundle;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;

public class MainActivity extends Activity {
  private EditText inputBox;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_main);

    inputBox = (EditText) findViewById(R.id.input_box);
    inputBox.setFocusable(true);
    inputBox.setFocusableInTouchMode(true);
    inputBox.requestFocus();
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (inputBox != null) {
      inputBox.requestFocus();
      InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
      if (imm != null) {
        imm.showSoftInput(inputBox, InputMethodManager.SHOW_IMPLICIT);
      }
    }
  }
}
