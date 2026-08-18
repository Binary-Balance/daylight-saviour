describe('mobile entry', () => {
  it('defines the proof background task before Expo Router starts', () => {
    const loaded: string[] = [];
    const manifest = jest.requireActual('../package.json') as { main: string };

    expect(manifest.main).toBe('src/fcm-transport-proof-entry.ts');

    jest.doMock(
      './features/change-reminders/fcm-transport-proof-background',
      () => {
        loaded.push('proof-background-task');
        return {};
      },
    );
    jest.doMock('expo-router/entry', () => {
      loaded.push('expo-router');
      return {};
    });

    jest.isolateModules(() => {
      jest.requireActual('./fcm-transport-proof-entry');
    });

    expect(loaded).toEqual(['proof-background-task', 'expo-router']);
  });
});
