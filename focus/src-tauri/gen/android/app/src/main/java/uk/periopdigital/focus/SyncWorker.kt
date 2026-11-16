package uk.periopdigital.focus

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Periodic background sync while Focus is closed (Android's WorkManager runs it about every
 * 15 minutes when there's a network). It syncs a copy of the database with the Rust engine and
 * replaces the file only if the app hasn't been opened meanwhile.
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val prefs = applicationContext.getSharedPreferences(BackgroundSync.PREFS, Context.MODE_PRIVATE)
    val root = prefs.getString("root", null) ?: return Result.success()
    val key = SecureStoreCrypto.read(applicationContext, "sync:key") ?: return Result.success()
    val licence = SecureStoreCrypto.read(applicationContext, "sync:licence") ?: ""
    return try {
      val report = FocusNative.runSync(root, key, licence)
      Log.i("FocusSync", report)
      Result.success()
    } catch (e: Throwable) {
      Log.w("FocusSync", "Background sync failed", e)
      Result.success()
    }
  }
}
