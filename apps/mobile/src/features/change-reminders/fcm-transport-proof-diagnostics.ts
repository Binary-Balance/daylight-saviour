/** Fixed local proof markers; never attach notification or device data. */
export enum FcmTransportProofDiagnosticStage {
  ExpoResponseReceived = 'expo-response-received',
  ReviewedDataAccepted = 'reviewed-data-accepted',
  TapDeliveredToReact = 'tap-delivered-to-react',
  CivilTimeReportApplied = 'civil-time-report-applied',
}

export function recordFcmTransportProofDiagnostic(
  proofBuild: boolean,
  stage: FcmTransportProofDiagnosticStage,
) {
  if (proofBuild) console.info(stage);
}
