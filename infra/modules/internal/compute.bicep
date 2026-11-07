targetScope = 'resourceGroup'

param applicationInsightsConnectionString string
param buildVersion string
param deploymentContainerUri string
param functionAppName string
param functionPlanName string
param fcmEnabled bool
param fcmTestSendEnabled bool
param fcmEntraAssertionAudience string
param fcmProjectId string
param fcmServiceAccountEmail string
param fcmWorkloadIdentityProvider string
param instanceMemoryMB int
param keyVaultUri string
param location string
param logAnalyticsWorkspaceId string
param maximumInstanceCount int
param reminderDispatch object?
param runtimeIdentityClientId string
param runtimeIdentityId string
param runtimeName string
param runtimeVersion string
param storageAccountName string
param tags object

var baseAppSettings = {
  APPLICATIONINSIGHTS_AUTHENTICATION_STRING: 'ClientId=${runtimeIdentityClientId};Authorization=AAD'
  APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsightsConnectionString
  AzureWebJobsStorage__accountName: storageAccountName
  AzureWebJobsStorage__clientId: runtimeIdentityClientId
  AzureWebJobsStorage__credential: 'managedidentity'
  BUILD_VERSION: buildVersion
  FCM_ENTRA_ASSERTION_AUDIENCE: fcmEntraAssertionAudience
  FUNCTIONS_EXTENSION_VERSION: '~4'
  FCM_PROJECT_ID: fcmProjectId
  FCM_RUNTIME_ENABLED: fcmEnabled ? 'true' : 'false'
  FCM_TEST_SEND_ENABLED: fcmTestSendEnabled ? 'true' : 'false'
  FCM_SERVICE_ACCOUNT_EMAIL: fcmServiceAccountEmail
  FCM_WORKLOAD_IDENTITY_PROVIDER: fcmWorkloadIdentityProvider
  KEY_VAULT_URI: keyVaultUri
  REMINDER_DISPATCH_ENABLED: (reminderDispatch.?enabled ?? false) ? 'true' : 'false'
  REMINDER_MANAGED_IDENTITY_CLIENT_ID: runtimeIdentityClientId
  REMINDER_STORAGE_ACCOUNT_NAME: storageAccountName
  REMINDER_SUBSCRIPTION_EXPIRY_ENABLED: (reminderDispatch.?subscriptionExpiryEnabled ?? false) ? 'true' : 'false'
}

// A caller that does not opt in gets none of these keys: an empty setting still
// exists, and it would read as a configured one.
var reminderDispatchAppSettings = reminderDispatch == null
  ? {}
  : {
      APNS_ENVIRONMENT: reminderDispatch.?apnsEnvironment
      APNS_KEY_ID: reminderDispatch.?apnsKeyId
      APNS_PRIVATE_KEY: reminderDispatch.?apnsPrivateKeyReference
      APNS_TEAM_ID: reminderDispatch.?apnsTeamId
      APNS_TOPIC: reminderDispatch.?apnsTopic
      TIME_ZONE_DATA_MANIFEST_URL: reminderDispatch.?timeZoneDataManifestUrl
      TIME_ZONE_DATA_TRUSTED_KEYS_JSON: reminderDispatch.?timeZoneDataTrustedKeysJson
    }

resource functionPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: functionPlanName
  location: location
  kind: 'functionapp'
  tags: tags
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentityId}': {}
    }
  }
  properties: {
    // With only a user-assigned identity, a Key Vault reference needs this set,
    // or the setting reaches the app as its literal text.
    keyVaultReferenceIdentity: reminderDispatch == null ? null : runtimeIdentityId
    functionAppConfig: {
      deployment: {
        storage: {
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: runtimeIdentityId
          }
          type: 'blobContainer'
          value: deploymentContainerUri
        }
      }
      runtime: {
        name: runtimeName
        version: runtimeVersion
      }
      scaleAndConcurrency: {
        instanceMemoryMB: instanceMemoryMB
        maximumInstanceCount: maximumInstanceCount
      }
    }
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    serverFarmId: functionPlan.id
    siteConfig: {
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      scmMinTlsVersion: '1.2'
    }
  }
}

resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: union(baseAppSettings, reminderDispatchAppSettings)
}

resource ftpBasicPublishingCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource scmBasicPublishingCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource functionAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-log-analytics'
  scope: functionApp
  properties: {
    logs: [
      {
        category: 'FunctionAppLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
    workspaceId: logAnalyticsWorkspaceId
  }
}

output defaultHostName string = functionApp.properties.defaultHostName
output functionAppId string = functionApp.id
