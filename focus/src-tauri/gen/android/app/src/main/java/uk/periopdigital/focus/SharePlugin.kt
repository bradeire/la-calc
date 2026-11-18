package uk.periopdigital.focus

import android.app.Activity
import android.content.Intent
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareFileArgs {
  lateinit var name: String
  lateinit var base64: String
  lateinit var mime: String
}

/**
 * Exports (backups, CSV, .ics) on Android: WebView ignores browser downloads, so the file is
 * written to the app's cache and offered through the system share sheet (Save to Files, Drive,
 * email…). Old exports are removed first so they don't accumulate.
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun shareFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareFileArgs::class.java)
      val safe = args.name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "focus-export" }
      val dir = File(activity.cacheDir, "exports").apply { mkdirs() }
      dir.listFiles()?.forEach { it.delete() }
      val file = File(dir, safe)
      file.writeBytes(Base64.decode(args.base64, Base64.NO_WRAP))
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
      val send = Intent(Intent.ACTION_SEND)
        .setType(args.mime)
        .putExtra(Intent.EXTRA_STREAM, uri)
        .putExtra(Intent.EXTRA_TITLE, safe)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.startActivity(Intent.createChooser(send, safe))
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Could not share the file", e)
    }
  }
}
