package os.arcane.host.android

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import java.net.NetworkInterface

class ArcaneAndroidSystemAdapter(context: Context) :
    ArcaneWebViewBridge.ExternalOpenProvider,
    ArcaneWebViewBridge.NetworkStatusProvider {
    private val applicationContext = context.applicationContext

    override fun openMailto(uri: String): Boolean {
        val canonicalUri = AndroidBridgeProtocol.canonicalMailtoUri(uri) ?: return false
        val parsed = try {
            Uri.parse(canonicalUri)
        } catch (_: Exception) {
            return false
        }
        val scheme = parsed.scheme ?: return false
        if (!scheme.equals(GeneratedAndroidMethodContracts.EXTERNAL_OPEN_INPUT_SCHEME, ignoreCase = true) || parsed.toString() != canonicalUri) return false
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse(canonicalUri))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val handler = applicationContext.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
            ?: return false
        val activity = handler.activityInfo ?: return false
        if (!activity.exported) return false
        intent.setClassName(activity.packageName, activity.name)
        applicationContext.startActivity(intent)
        return true
    }

    override fun currentNetworkStatus(): ArcaneWebViewBridge.NetworkStatus {
        val interfaces = NetworkInterface.getNetworkInterfaces()
            ?: throw IllegalStateException("Android network interfaces are unavailable.")
        var interfaceCount = 0
        while (interfaces.hasMoreElements()) {
            val networkInterface = interfaces.nextElement()
            val addresses = networkInterface.inetAddresses
            var hasExternalAddress = false
            while (addresses.hasMoreElements()) {
                val address = addresses.nextElement()
                if (!address.isLoopbackAddress) {
                    hasExternalAddress = true
                    break
                }
            }
            if (hasExternalAddress) {
                interfaceCount += 1
                if (interfaceCount > GeneratedAndroidMethodContracts.NETWORK_STATUS_OUTPUT_MAX_INTERFACE_COUNT) {
                    throw IllegalStateException("Android returned too many network interfaces.")
                }
            }
        }
        return ArcaneWebViewBridge.NetworkStatus(interfaceCount > 0, interfaceCount)
    }

    private companion object {
    }
}
