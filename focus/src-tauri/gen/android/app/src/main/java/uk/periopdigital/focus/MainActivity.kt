package uk.periopdigital.focus

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    intent = asFocusLink(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    val converted = asFocusLink(intent)
    setIntent(converted)
    super.onNewIntent(converted)
  }

  /**
   * Text shared to Focus from another app (e.g. a Claude reply) arrives as ACTION_SEND.
   * Turn it into a focus://capture link so the deep-link plugin delivers it like a tapped
   * link; Focus then shows it in the Capture dialog for review. Nothing is created here.
   */
  private fun asFocusLink(intent: Intent): Intent {
    if (intent.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return intent
    val text = listOfNotNull(
      intent.getStringExtra(Intent.EXTRA_SUBJECT),
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    ).filter { it.isNotBlank() }.joinToString("\n").take(20_000)
    if (text.isBlank()) return intent
    val link = Uri.Builder().scheme("focus").authority("capture").appendQueryParameter("text", text).build()
    return Intent(Intent.ACTION_VIEW, link).setPackage(packageName)
  }
}
