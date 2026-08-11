export type ContractAuthority =
  | "public"
  | "bootstrap-token"
  | "polling-token"
  | "administrator"
  | "administrator-or-device";

export const contractAuthorityByMethod = {
  "nama.api.v1.AuthService.GetCurrentUser": "administrator",
  "nama.api.v1.AuthService.SignIn": "public",
  "nama.api.v1.AuthService.SignOut": "administrator",
  "nama.api.v1.DeviceService.ApprovePairing": "administrator",
  "nama.api.v1.DeviceService.BeginPairing": "public",
  "nama.api.v1.DeviceService.GetPairingStatus": "polling-token",
  "nama.api.v1.DeviceService.ListDevices": "administrator",
  "nama.api.v1.DeviceService.RevokeDevice": "administrator",
  "nama.api.v1.HealthService.Check": "administrator",
  "nama.api.v1.HealthService.GetDiagnostics": "administrator",
  "nama.api.v1.ProviderService.CreateProviderInstance": "administrator",
  "nama.api.v1.ProviderService.DeleteProviderInstance": "administrator",
  "nama.api.v1.ProviderService.GetProviderInstance": "administrator",
  "nama.api.v1.ProviderService.ListProviderInstances": "administrator",
  "nama.api.v1.ProviderService.ListProviderTypes": "administrator",
  "nama.api.v1.ProviderService.TestProviderConfiguration": "administrator",
  "nama.api.v1.ProviderService.TestProviderInstance": "administrator",
  "nama.api.v1.ProviderService.UpdateProviderInstance": "administrator",
  "nama.api.v1.SetupService.CreateAdministrator": "bootstrap-token",
  "nama.api.v1.SetupService.GetStatus": "public",
  "nama.api.v1.SyncService.GetSyncRun": "administrator",
  "nama.api.v1.SyncService.GetSyncStatus": "administrator",
  "nama.api.v1.SyncService.TriggerSync": "administrator",
} as const satisfies Record<string, ContractAuthority>;
