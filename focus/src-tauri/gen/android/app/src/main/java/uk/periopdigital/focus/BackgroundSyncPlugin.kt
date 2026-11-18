package uk.periopdigital.focus

import android.app.Activity
import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.util.concurrent.TimeUnit

@InvokeArg
class BackgroundSyncArgs {
  var enabled: Boolean = false
  lateinit var root: String
}

object BackgroundSync {
  const val PREFS = "focus_bg_sync"
  const val WORK = "focus-background-sync"
}

/** Turns the periodic background sync on or off (called by the app when sync is set up). */
@TauriPlugin
class BackgroundSyncPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun configure(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BackgroundSyncArgs::class.java)
      val wm = WorkManager.getInstance(activity.applicationContext)
      activity.getSharedPreferences(BackgroundSync.PREFS, Context.MODE_PRIVATE).edit().putString("root", args.root).apply()
      if (args.enabled) {
        val request = PeriodicWorkRequest.Builder(SyncWorker::class.java, 15, TimeUnit.MINUTES)
          .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
          .build()
        wm.enqueueUniquePeriodicWork(BackgroundSync.WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
      } else {
        wm.cancelUniqueWork(BackgroundSync.WORK)
      }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Could not schedule background sync", e)
    }
  }
}
