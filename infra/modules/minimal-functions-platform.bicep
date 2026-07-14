targetScope = 'resourceGroup'

@sealed()
type PlatformResourceNames = {
  @minLength(2)
  @maxLength(60)
  functionApp: string

  @minLength(1)
  @maxLength(60)
  functionPlan: string

  @minLength(3)
  @maxLength(24)
  storageAccount: string

  @minLength(3)
  @maxLength(24)
  keyVault: string

  @minLength(4)
  @maxLength(63)
  logAnalyticsWorkspace: string

  @minLength(1)
  @maxLength(260)
  applicationInsights: string

  @minLength(3)
  @maxLength(128)
  runtimeIdentity: string

  @minLength(3)
  @maxLength(63)
  deploymentContainer: string
}

@sealed()
type RuntimeSettings = {
  name: 'node'

  version: '22' | '24'
}

@sealed()
type ScaleSettings = {
  @minValue(1)
  @maxValue(1000)
  maximumInstanceCount: int

  instanceMemoryMB: 512 | 2048 | 4096
}

@sealed()
type SecuritySettings = {
  @minValue(7)
  @maxValue(90)
  keyVaultSoftDeleteRetentionDays: int

  @minValue(30)
  @maxValue(730)
  logRetentionDays: int
}

@description('Azure region for every resource in this portable platform module.')
@minLength(1)
param location string = resourceGroup().location

@description('Caller-approved Azure resource names. The module never derives environment identifiers.')
param resourceNames PlatformResourceNames

@description('Tags applied to resources that support tags.')
param tags object = {}

@description('Azure Functions language runtime. This notification platform supports Node.js only.')
param runtime RuntimeSettings = {
  name: 'node'
  version: '24'
}

@description('Flex Consumption scale limits. No always-ready instances are created.')
param scale ScaleSettings = {
  maximumInstanceCount: 10
  instanceMemoryMB: 512
}

@description('Retention settings. TLS, managed-identity access, RBAC, purge protection, and public-blob denial are enforced invariants.')
param security SecuritySettings = {
  keyVaultSoftDeleteRetentionDays: 90
  logRetentionDays: 30
}

@description('Build identifier returned by the notification-service health endpoint.')
@minLength(1)
@maxLength(64)
param buildVersion string = 'unavailable'

module identity './internal/identity.bicep' = {
  name: 'notification-platform-identity'
  params: {
    location: location
    name: resourceNames.runtimeIdentity
    tags: tags
  }
}

module observability './internal/observability.bicep' = {
  name: 'notification-platform-observability'
  params: {
    applicationInsightsName: resourceNames.applicationInsights
    location: location
    logAnalyticsWorkspaceName: resourceNames.logAnalyticsWorkspace
    logRetentionDays: security.logRetentionDays
    tags: tags
  }
}

module storage './internal/storage.bicep' = {
  name: 'notification-platform-storage'
  params: {
    accountName: resourceNames.storageAccount
    deploymentContainerName: resourceNames.deploymentContainer
    location: location
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    tags: tags
  }
}

module vault './internal/key-vault.bicep' = {
  name: 'notification-platform-key-vault'
  params: {
    location: location
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    name: resourceNames.keyVault
    softDeleteRetentionDays: security.keyVaultSoftDeleteRetentionDays
    tags: tags
  }
}

module authorization './internal/authorization.bicep' = {
  name: 'notification-platform-authorization'
  params: {
    applicationInsightsName: resourceNames.applicationInsights
    keyVaultName: resourceNames.keyVault
    runtimePrincipalId: identity.outputs.principalId
    storageAccountName: resourceNames.storageAccount
  }
  dependsOn: [
    observability
    storage
    vault
  ]
}

module compute './internal/compute.bicep' = {
  name: 'notification-platform-compute'
  params: {
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    buildVersion: buildVersion
    deploymentContainerUri: storage.outputs.deploymentContainerUri
    functionAppName: resourceNames.functionApp
    functionPlanName: resourceNames.functionPlan
    instanceMemoryMB: scale.instanceMemoryMB
    keyVaultUri: vault.outputs.uri
    location: location
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    maximumInstanceCount: scale.maximumInstanceCount
    runtimeIdentityClientId: identity.outputs.clientId
    runtimeIdentityId: identity.outputs.id
    runtimeName: runtime.name
    runtimeVersion: runtime.version
    storageAccountName: resourceNames.storageAccount
    tags: tags
  }
  dependsOn: [
    authorization
  ]
}

output platform object = {
  applicationInsightsId: observability.outputs.applicationInsightsId
  deploymentContainerUri: storage.outputs.deploymentContainerUri
  functionAppDefaultHostName: compute.outputs.defaultHostName
  functionAppId: compute.outputs.functionAppId
  keyVaultId: vault.outputs.id
  keyVaultUri: vault.outputs.uri
  logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
  runtimeIdentityClientId: identity.outputs.clientId
  runtimeIdentityId: identity.outputs.id
  runtimeIdentityPrincipalId: identity.outputs.principalId
  storageAccountId: storage.outputs.accountId
}
