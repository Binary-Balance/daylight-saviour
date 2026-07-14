targetScope = 'resourceGroup'

param location string
param name string
param tags object

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

output id string = runtimeIdentity.id
output clientId string = runtimeIdentity.properties.clientId
output principalId string = runtimeIdentity.properties.principalId
