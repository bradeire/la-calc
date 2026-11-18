package uk.periopdigital.focus

/** Native entry points in the Rust library (src-tauri/src/bgsync.rs). */
object FocusNative {
  init {
    System.loadLibrary("focus_lib")
  }

  /** Tell the background sync that the app is (not) open, so it never overwrites a live session. */
  @JvmStatic external fun setAppAlive(alive: Boolean)

  /** Sync the database in [root] (the app-data folder). Returns a small JSON report. */
  @JvmStatic external fun runSync(root: String, key: String, licence: String): String
}
