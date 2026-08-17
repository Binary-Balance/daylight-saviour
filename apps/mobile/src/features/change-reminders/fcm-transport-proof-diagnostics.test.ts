import {
  FcmTransportProofDiagnosticStage,
  recordFcmTransportProofDiagnostic,
} from './fcm-transport-proof-diagnostics';

describe('FCM transport-proof diagnostics', () => {
  it('emits only the exact stage in proof builds and nothing otherwise', () => {
    const output = jest.spyOn(console, 'info').mockImplementation();

    recordFcmTransportProofDiagnostic(
      false,
      FcmTransportProofDiagnosticStage.ExpoResponseReceived,
    );
    recordFcmTransportProofDiagnostic(
      true,
      FcmTransportProofDiagnosticStage.CivilTimeReportApplied,
    );

    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith('civil-time-report-applied');
  });
});
