package uk.legaxia.estudia;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GrabadoraPlugin.class);
        registerPlugin(ExtractorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
