targetScope = 'resourceGroup'

var resourceNames = {
  functionApp: 'sample-notify-app'
  functionPlan: 'sample-notify-plan'
  storageAccount: 'samplenotify123'
  keyVault: 'sample-notify-vault'
  logAnalyticsWorkspace: 'sample-notify-logs'
  applicationInsights: 'sample-notify-insights'
  runtimeIdentity: 'sample-notify-identity'
  deploymentContainer: 'deployment'
}

module platform '../modules/minimal-functions-platform.bicep' = {
  name: 'sample-notify-platform'
  params: {
    resourceNames: resourceNames
  }
}

resource callerVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: resourceNames.keyVault
}

resource applicationSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: callerVault
  name: 'application-secret'
}

var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
// The caller knows the identity resource ID from the names it passed to the module.
var runtimeIdentityResourceId = resourceId(
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  resourceNames.runtimeIdentity
)

resource applicationSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationSecret.id, runtimeIdentityResourceId, keyVaultSecretsUserRoleId)
  scope: applicationSecret
  properties: {
    principalId: platform.outputs.platform.runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsUserRoleId
    )
  }
}

output callerRuntimePrincipalId string = platform.outputs.platform.runtimeIdentityPrincipalId
