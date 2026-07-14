targetScope = 'resourceGroup'

param applicationInsightsConnectionString string
param buildVersion string
param deploymentContainerUri string
param functionAppName string
param functionPlanName string
param instanceMemoryMB int
param keyVaultUri string
param location string
param logAnalyticsWorkspaceId string
param maximumInstanceCount int
param runtimeIdentityClientId string
param runtimeIdentityId string
param runtimeName string
param runtimeVersion string
param storageAccountName string
param tags object

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
  properties: {
    APPLICATIONINSIGHTS_AUTHENTICATION_STRING: 'ClientId=${runtimeIdentityClientId};Authorization=AAD'
    APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsightsConnectionString
    AzureWebJobsStorage__accountName: storageAccountName
    AzureWebJobsStorage__clientId: runtimeIdentityClientId
    AzureWebJobsStorage__credential: 'managedidentity'
    BUILD_VERSION: buildVersion
    FUNCTIONS_EXTENSION_VERSION: '~4'
    KEY_VAULT_URI: keyVaultUri
  }
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
