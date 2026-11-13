package au.com.binarybalance.appsleep

import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Reads and opens the settings that let Android or Samsung put the app to
// sleep when unused. A sleeping app receives no push messages, so Change
// Reminders sent months apart would silently stop arriving.
class AppSleepModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext)

  // Samsung's "Never sleeping apps" list. Samsung offers no way to read it.
  private val neverSleepingAppsIntent
    get() = Intent("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY")
      .setPackage("com.samsung.android.lool")
      .putExtra("activity_type", 2)

  override fun definition() = ModuleDefinition {
    Name("AppSleep")

    // True only where Android 12+ can pause the app (status API_31). Android 11
    // and earlier only reset permissions, which leaves push working.
    AsyncFunction("canPauseApp") { promise: Promise ->
      val status = PackageManagerCompat.getUnusedAppRestrictionsStatus(context)
      status.addListener(
        {
          promise.resolve(
            runCatching { status.get() }.getOrNull() ==
              UnusedAppRestrictionsConstants.API_31,
          )
        },
        ContextCompat.getMainExecutor(context),
      )
    }

    AsyncFunction("openPauseSetting") {
      appContext.throwingActivity.startActivity(
        IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName),
      )
    }

    Function("canOpenNeverSleepingApps") {
      neverSleepingAppsIntent.resolveActivity(context.packageManager) != null
    }

    AsyncFunction("openNeverSleepingApps") {
      appContext.throwingActivity.startActivity(neverSleepingAppsIntent)
    }
  }
}
