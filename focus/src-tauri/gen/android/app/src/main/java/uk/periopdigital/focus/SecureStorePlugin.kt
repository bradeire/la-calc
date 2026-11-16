package uk.periopdigital.focus

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretKeyArgs {
  lateinit var key: String
}

@InvokeArg
class SecretSetArgs {
  lateinit var key: String
  lateinit var value: String
}

/**
 * Secrets (API keys, webhook secrets, calendar addresses) encrypted with an AES-256-GCM key
 * that lives in the Android Keystore and never leaves it. Only "iv:ciphertext" is stored, in
 * the app's private preferences. If the key is lost (e.g. data restored to a new phone), the
 * value reads as missing and the user is asked to enter it again.
 */
@TauriPlugin
class SecureStorePlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs by lazy { activity.getSharedPreferences("focus_secure_store", Context.MODE_PRIVATE) }

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
  private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)

  @Command
  fun set(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretSetArgs::class.java)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val ct = cipher.doFinal(args.value.toByteArray(Charsets.UTF_8))
      prefs.edit().putString(args.key, b64(cipher.iv) + ":" + b64(ct)).apply()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Could not store the secret securely", e)
    }
  }

  @Command
  fun get(invoke: Invoke) {
    val result = JSObject()
    try {
      val args = invoke.parseArgs(SecretKeyArgs::class.java)
      val stored = prefs.getString(args.key, null)
      if (stored == null) {
        result.put("value", null)
      } else {
        val (iv, ct) = stored.split(":", limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, unb64(iv)))
        result.put("value", String(cipher.doFinal(unb64(ct)), Charsets.UTF_8))
      }
    } catch (e: Exception) {
      // Undecryptable (key lost after a restore or reinstall): treat as missing.
      result.put("value", null)
    }
    invoke.resolve(result)
  }

  @Command
  fun delete(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretKeyArgs::class.java)
      prefs.edit().remove(args.key).apply()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Could not delete the secret", e)
    }
  }

  companion object {
    private const val ALIAS = "focus-secure-store"
  }
}
