// Test helper: lets the app run in a browser without a guitar (for automated checks).
//
// Inject before the page loads, e.g. with Playwright:
//   await page.addInitScript({ path: 'tools/browser-fake-input.js' });
//   await page.goto('http://localhost:5173/?fakeSrc=di&fakePeakDb=-9');
//
// URL parameters:
//   (none)          sawtooth tone on the RIGHT channel, like the Hi-Z input 2 of a Behringer UM2
//   fakeFreq=110    tone frequency, Hz
//   fakeLevel=0.12  tone amplitude
//   fakeSrc=di      a real dry guitar recording (TONE3000 demo DI, MIT) instead of the tone
//   di=<file name>  which recording, default "Brit - Guitar.wav"
//   fakePeakDb=-9   peak level of the recording, dBFS
//   fakeDeny=1      the browser refuses microphone access
//
// In the page: window.__fake.restart() restarts the recording; window.__kvEngine is the engine
// (dev builds only) with readOutputDb('peak' | 'rms').
(() => {
  const params = new URLSearchParams(location.search);
  const devices = [
    { deviceId: 'default', kind: 'audioinput', label: 'Default - Фейковый вход', groupId: 'g1' },
    { deviceId: 'fake-um2', kind: 'audioinput', label: 'Behringer UM2 (фейк)', groupId: 'g2' },
    { deviceId: 'communications', kind: 'audioinput', label: 'Communications - дубль', groupId: 'g1' },
    { deviceId: 'default', kind: 'audiooutput', label: 'Default - Динамики', groupId: 'g1' },
  ];
  navigator.mediaDevices.enumerateDevices = async () => devices.map((d) => ({ ...d, toJSON: () => d }));
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__lastConstraints = constraints;
    if (params.get('fakeDeny')) throw new DOMException('Permission denied', 'NotAllowedError');
    const ctx = new AudioContext();
    await ctx.resume();
    const gain = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    gain.connect(merger, 0, 1); // right channel only
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    merger.connect(dest);
    window.__fake = { ctx, gain };

    if (params.get('fakeSrc') === 'di') {
      const name = params.get('di') || 'Brit - Guitar.wav';
      const url =
        'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/' +
        `ea8dc285462d6cedd982691b9f090cd03dac04a2/ui/public/inputs/${encodeURIComponent(name)}`;
      const audio = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      let peak = 0;
      for (const v of audio.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
      gain.gain.value = 10 ** (Number(params.get('fakePeakDb') || -9) / 20) / peak;
      let source = null;
      window.__fake.restart = () => {
        source?.stop();
        source = new AudioBufferSourceNode(ctx, { buffer: audio, loop: true });
        source.connect(gain);
        source.start();
      };
      window.__fake.restart();
    } else {
      const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: Number(params.get('fakeFreq') || 110) });
      const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2500 });
      gain.gain.value = Number(params.get('fakeLevel') || 0.12);
      osc.connect(lowpass).connect(gain);
      osc.start();
    }
    return dest.stream;
  };
})();
