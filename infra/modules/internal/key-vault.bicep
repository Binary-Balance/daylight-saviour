targetScope = 'resourceGroup'

param location string
param logAnalyticsWorkspaceId string
param name string
param softDeleteRetentionDays int
param tags object

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    accessPolicies: []
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enableSoftDelete: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
    softDeleteRetentionInDays: softDeleteRetentionDays
    tenantId: subscription().tenantId
  }
}

resource vaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-log-analytics'
  scope: vault
  properties: {
    logs: [
      {
        category: 'AuditEvent'
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

output id string = vault.id
output uri string = vault.properties.vaultUri
