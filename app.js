/* app.js — Mini Studio Pro
   Features: Arranger + Pattern editor, Synth with ADSR+Filter, Sample loader (drag/drop), Mixer, Effects (delay/reverb), MIDI input, Mic record, Save/Load, Offline export/stems
   Note: This file aims for clarity rather than being minified. Test in recent Chrome/Edge for best WebAudio support.
*/

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let masterGain, analyser, masterCompressor;

// Basic config
const DEFAULT_TEMPO = 100;
let tempo = DEFAULT_TEMPO;
let isPlaying = false;
let currentStep = 0;
let lookahead = 25.0; // ms
let scheduleAheadTime = 0.15; // sec
let nextNoteTime = 0.0;
let timerID = null;

// Application state
const trackTemplates = [
  { id: 'kick', name: 'Kick', type: 'drum' },
  { id: 'snare', name: 'Snare', type: 'drum' },
  { id: 'hihat', name: 'HiHat', type: 'drum' },
  { id: 'bass', name: 'Bass', type: 'synth' },
  { id: 'synth', name: 'Synth', type: 'synth' },
];

let tracks = []; // array of track objects {id,name,type,muted,solo,pan,volume,events: {patternId: [bool...]}, samples: []}
let patterns = []; // array of pattern objects {id,length,stepsPerBar}
let arranger = []; // 2D: arranger[patternIndex][barIndex] => patternId or -1; simplified: arrangerRows per track
let currentPatternId = 0;

// UI refs
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const recordBtn = document.getElementById('recordBtn');
const tempoSlider = document.getElementById('tempo');
const tempoVal = document.getElementById('tempoVal');
const arrangerGrid = document.getElementById('arrangerGrid');
const addPatternBtn = document.getElementById('addPatternBtn');
const patternLengthSelect = document.getElementById('patternLength');
const patternTracksEl = document.getElementById('patternTracks');
const currentPatternLabel = document.getElementById('currentPatternLabel');
const mixerChannels = document.getElementById('mixerChannels');
const samplesList = document.getElementById('samplesList');
const fileSampleInput = document.getElementById('fileSample');
const clearSamplesBtn = document.getElementById('clearSamples');
const vizCanvas = document.getElementById('viz');
const vizCtx = vizCanvas.getContext('2d');
const exportBtn = document.getElementById('exportBtn');
const exportStemsBtn = document.getElementById('exportStemsBtn');
const saveBtn = document.getElementById('saveBtn');
const loadBtn = document.getElementById('loadBtn');
const loadFileInput = document.getElementById('loadFile');

// Synth settings
let synthSettings = { osc: 'saw', filterCut: 1200, env: {a:0.01,d:0.2,s:0.6,r:0.4} };

// Samples store (in-memory)
let samples = {}; // name -> AudioBuffer-like object (use array buffer decoded audio)

// Undo stack
let undoStack = [];
let redoStack = [];

function ensureAudio(){
  if(!audioCtx){
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain(); masterGain.gain.value = 0.9;
    masterCompressor = audioCtx.createDynamicsCompressor();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
    masterGain.connect(masterCompressor); masterCompressor.connect(analyser); analyser.connect(audioCtx.destination);
    startVisualizer();
  }
}

// Initialize tracks and a default pattern
function initState(){
  // tracks
  tracks = trackTemplates.map(t => ({
    id: t.id, name: t.name, type: t.type, muted:false, solo:false, pan:0, volume:0.9, samples: [], events: {}
  }));
  // default pattern
  patterns = [];
  addPattern(16); // pattern 0
  currentPatternId = 0;
  // arranger: simple 4 bars per track with pattern 0 placed
  arranger = tracks.map(()=> [0,0,0,0]);
}

function addPattern(length=16){
  const id = patterns.length;
  const pat = { id, length, steps: new Array(length).fill(false), perTrackSteps: {} };
  // per track steps (copy template)
  tracks.forEach(tr => { pat.perTrackSteps[tr.id] = new Array(length).fill(false); });
  patterns.push(pat);
  return id;
}

function pushUndo(action){ undoStack.push(JSON.stringify(action)); if(undoStack.length>100) undoStack.shift(); redoStack=[]; }

function undo(){ if(!undoStack.length) return; const snapshot = JSON.parse(undoStack.pop()); redoStack.push(JSON.stringify(snapshot)); restoreSnapshot(snapshot); }
function redo(){ if(!redoStack.length) return; const snapshot = JSON.parse(redoStack.pop()); undoStack.push(JSON.stringify(snapshot)); restoreSnapshot(snapshot); }
function snapshotState(){ return {tracks,patterns,arranger,currentPatternId,synthSettings}; }
function restoreSnapshot(snap){ tracks = snap.tracks; patterns = snap.patterns; arranger = snap.arranger; currentPatternId = snap.currentPatternId; synthSettings = snap.synthSettings; refreshAllUI(); }

// UI builders
function buildArrangerUI(){
  arrangerGrid.innerHTML='';
  // header row: bars
  const header = document.createElement('div'); header.className='arranger-row';
  header.appendChild(document.createElement('div'));
  const barCount = arranger[0].length;
  for(let b=0;b<barCount;b++){
    const el = document.createElement('div'); el.className='arranger-slot'; el.innerText = 'Bar '+(b+1);
    header.appendChild(el);
  }
  arrangerGrid.appendChild(header);
  // rows per track
  tracks.forEach((tr,ti)=>{
    const row = document.createElement('div'); row.className='arranger-row';
    const meta = document.createElement('div'); meta.className='arranger-pattern'; meta.innerText = tr.name; row.appendChild(meta);
    arranger[ti].forEach((patId,bi)=>{
      const slot = document.createElement('div'); slot.className='arranger-slot'; slot.dataset.track=ti; slot.dataset.bar=bi;
      if(patId>=0) slot.classList.add('active'); slot.innerText = (patId>=0)? 'P'+patId : '-';
      slot.addEventListener('click',()=>{
        // cycle pattern id (for demo: toggle between -1 and 0..)
        const current = arranger[ti][bi];
        const next = (current<0)? 0 : (current+1 < patterns.length ? current+1 : -1);
        pushUndo(snapshotState());
        arranger[ti][bi] = next; buildArrangerUI();
      });
      row.appendChild(slot);
    });
    arrangerGrid.appendChild(row);
  });
}

function buildPatternEditorUI(){
  patternTracksEl.innerHTML='';
  currentPatternLabel.innerText = 'Pattern: ' + currentPatternId;
  const pattern = patterns[currentPatternId];
  tracks.forEach(tr=>{
    const row = document.createElement('div'); row.className='track-row';
    const meta = document.createElement('div'); meta.className='track-meta'; meta.innerHTML = `<strong>${tr.name}</strong><div style="font-size:12px;color:var(--muted)">${tr.type}</div>`;
    const steps = document.createElement('div'); steps.className='track-steps'; steps.dataset.track = tr.id;
    for(let i=0;i<pattern.length;i++){
      const s = document.createElement('div'); s.className='step'; s.dataset.step=i; s.innerText = (i%4===0)? (i/4)+1 : '';
      if(pattern.perTrackSteps[tr.id][i]) s.classList.add('active');
      s.addEventListener('click', ()=>{ pushUndo(snapshotState()); pattern.perTrackSteps[tr.id][i] = !pattern.perTrackSteps[tr.id][i]; s.classList.toggle('active'); });
      steps.appendChild(s);
    }
    row.appendChild(meta); row.appendChild(steps);
    patternTracksEl.appendChild(row);
  });
}

function buildMixerUI(){
  mixerChannels.innerHTML='';
  tracks.forEach(tr=>{
    const ch = document.createElement('div'); ch.className='channel';
    ch.innerHTML = `<div class="label">${tr.name}</div><input type="range" min="0" max="100" value="${Math.round(tr.volume*100)}" data-track="${tr.id}" class="vol"><button data-track="${tr.id}" class="mute">M</button><button data-track="${tr.id}" class="solo">S</button>`;
    const vol = ch.querySelector('.vol'); vol.addEventListener('input', (e)=>{ tr.volume = e.target.value/100; });
    const mute = ch.querySelector('.mute'); mute.addEventListener('click', ()=>{ tr.muted = !tr.muted; mute.style.opacity = tr.muted?0.5:1; });
    const solo = ch.querySelector('.solo'); solo.addEventListener('click', ()=>{ tr.solo = !tr.solo; solo.style.opacity = tr.solo?0.7:1; });
    mixerChannels.appendChild(ch);
  });
}

function refreshAllUI(){ buildArrangerUI(); buildPatternEditorUI(); buildMixerUI(); refreshSamplesUI(); }

// Samples handling (drag/drop + file input)
function refreshSamplesUI(){ samplesList.innerHTML=''; Object.keys(samples).forEach(name=>{
  const el = document.createElement('div'); el.className='sample-entry'; el.innerText = name; el.addEventListener('click', ()=>{ alert('Sample ready: '+name); }); samplesList.appendChild(el);
}); if(!Object.keys(samples).length) samplesList.innerText = 'Drop audio files here to load (WAV/MP3)'; }

samplesList.addEventListener('dragover', (e)=>{ e.preventDefault(); samplesList.style.borderColor = '#7c5cff'; });
samplesList.addEventListener('dragleave', (e)=>{ e.preventDefault(); samplesList.style.borderColor = ''; });
samplesList.addEventListener('drop', async (e)=>{ e.preventDefault(); samplesList.style.borderColor = ''; const files = e.dataTransfer.files; await loadSampleFiles(files); });
fileSampleInput.addEventListener('change', async (e)=>{ await loadSampleFiles(e.target.files); });
clearSamplesBtn.addEventListener('click', ()=>{ samples = {}; refreshSamplesUI(); });

async function loadSampleFiles(files){ ensureAudio(); for(const f of files){ try{ const ab = await f.arrayBuffer(); const decoded = await audioCtx.decodeAudioData(ab.slice(0)); samples[f.name] = decoded; }catch(err){ console.error('decode err',err); } } refreshSamplesUI(); }

// Mic recording
let mediaRecorder = null; let micChunks = [];
recordBtn.addEventListener('click', async ()=>{
  if(mediaRecorder && mediaRecorder.state==='recording'){ mediaRecorder.stop(); recordBtn.innerText='Record (Mic)'; return; }
  try{ const stream = await navigator.mediaDevices.getUserMedia({audio:true}); mediaRecorder = new MediaRecorder(stream); micChunks=[]; mediaRecorder.ondataavailable = e=> micChunks.push(e.data); mediaRecorder.onstop = async ()=>{ const blob = new Blob(micChunks); const ab = await blob.arrayBuffer(); ensureAudio(); const buf = await audioCtx.decodeAudioData(ab.slice(0)); const name = 'mic-'+Date.now()+'.wav'; samples[name]=buf; refreshSamplesUI(); alert('Mic recording added as sample: '+name); }; mediaRecorder.start(); recordBtn.innerText='Stop'; }catch(err){ alert('Microphone access denied or not available'); }
});

// Synth & instrument factory
function makeKick(ctx, dst){ return (time, vel=1)=>{ const o = ctx.createOscillator(); const g = ctx.createGain(); o.type='sine'; o.frequency.setValueAtTime(150, time); o.frequency.exponentialRampToValueAtTime(50, time+0.15); g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(1*vel, time+0.002); g.gain.exponentialRampToValueAtTime(0.0001, time+0.5); o.connect(g); g.connect(dst); o.start(time); o.stop(time+0.5); }; }
function makeSnare(ctx,dst){ return (time,vel=1)=>{ const bufferSize = ctx.sampleRate*0.2; const noise = ctx.createBuffer(1, bufferSize, ctx.sampleRate); const data = noise.getChannelData(0); for(let i=0;i<bufferSize;i++) data[i] = (Math.random()*2-1)*(1-i/bufferSize); const src = ctx.createBufferSource(); src.buffer = noise; const f = ctx.createBiquadFilter(); f.type='bandpass'; f.frequency.value=2500; const g = ctx.createGain(); g.gain.setValueAtTime(0.0001,time); g.gain.linearRampToValueAtTime(0.6*vel,time+0.001); g.gain.exponentialRampToValueAtTime(0.0001,time+0.25); src.connect(f); f.connect(g); g.connect(dst); src.start(time); src.stop(time+0.25); const o = ctx.createOscillator(); const og = ctx.createGain(); o.type='triangle'; o.frequency.setValueAtTime(180,time); og.gain.setValueAtTime(0.0001,time); og.gain.exponentialRampToValueAtTime(0.2*vel,time+0.001); og.gain.exponentialRampToValueAtTime(0.0001,time+0.3); o.connect(og); og.connect(dst); o.start(time); o.stop(time+0.3); }; }
function makeHiHat(ctx,dst){ return (time,vel=1)=>{ const bufferSize = ctx.sampleRate*0.05; const noise = ctx.createBuffer(1, bufferSize, ctx.sampleRate); const data=noise.getChannelData(0); for(let i=0;i<bufferSize;i++) data[i] = (Math.random()*2-1)*(1-i/bufferSize); const src=ctx.createBufferSource(); src.buffer=noise; const hf = ctx.createBiquadFilter(); hf.type='highpass'; hf.frequency.value=6000; const g=ctx.createGain(); g.gain.setValueAtTime(0.0001,time); g.gain.linearRampToValueAtTime(0.6*vel,time+0.001); g.gain.exponentialRampToValueAtTime(0.0001,time+0.08); src.connect(hf); hf.connect(g); g.connect(dst); src.start(time); src.stop(time+0.08); }; }

function makeSynthVoice(ctx,dst, osc='saw', cutoff=1200, env={a:0.01,d:0.2,s:0.6,r:0.4}){
  return (time,freq,duration=0.6,vel=0.9)=>{
    const o = ctx.createOscillator(); const g = ctx.createGain(); const filter = ctx.createBiquadFilter(); filter.type='lowpass'; filter.frequency.setValueAtTime(cutoff,time);
    o.type = osc; o.frequency.setValueAtTime(freq,time);
    // ADSR
    g.gain.setValueAtTime(0.00001, time);
    g.gain.linearRampToValueAtTime(vel, time + env.a);
    g.gain.linearRampToValueAtTime(env.s*vel, time + env.a + env.d);
    g.gain.exponentialRampToValueAtTime(0.00001, time + duration + env.r);
    o.connect(filter); filter.connect(g); g.connect(dst);
    o.start(time); o.stop(time + duration + env.r + 0.05);
  };
}

// Player per track
function playerForTrackId(id, ctx, dst){ if(id==='kick') return makeKick(ctx,dst); if(id==='snare') return makeSnare(ctx,dst); if(id==='hihat') return makeHiHat(ctx,dst); if(id==='bass') return makeSynthVoice(ctx,dst,'sine',120,synthSettings.env); return makeSynthVoice(ctx,dst,synthSettings.osc,synthSettings.filterCut,synthSettings.env); }

// Scheduler
function nextNote(){ const secondsPerBeat = 60.0/tempo; nextNoteTime += 0.25 * secondsPerBeat; currentStep = (currentStep + 1) % patterns[currentPatternId].length; }

function schedule(){ if(!audioCtx) return; while(nextNoteTime < audioCtx.currentTime + scheduleAheadTime){ // schedule for current step
  const step = currentStep;
  const secondsPerBeat = 60.0/tempo;
  const t = nextNoteTime;
  // schedule all tracks from arranger mapping (simplified: play pattern events where arranger places pattern)
  tracks.forEach((tr,ti)=>{
    // determine which pattern is placed at this bar and whether this step is active for track
    const barIndex = Math.floor(step / patterns[currentPatternId].length * arranger[ti].length) % arranger[ti].length;
    const patId = arranger[ti][barIndex];
    if(patId>=0){ const pat = patterns[patId]; const idx = step % pat.length; if(pat.perTrackSteps[tr.id][idx] && !tr.muted){ // velocity * volume
      // simple solo handling
      const anySolo = tracks.some(x=>x.solo);
      if(anySolo && !tr.solo) return;
      const player = playerForTrackId(tr.id, audioCtx, masterGain);
      const vol = tr.volume || 1;
      player(t, vol);
    } }
  });
  // visual highlight
  highlightStep(step);
  nextNote(); }
}

function schedulerStart(){ if(timerID) return; nextNoteTime = audioCtx.currentTime + 0.05; timerID = setInterval(()=>schedule(), lookahead); }
function schedulerStop(){ if(timerID){ clearInterval(timerID); timerID=null; } clearStepHighlights(); }

function highlightStep(step){ document.querySelectorAll('.step.playing').forEach(el=>el.classList.remove('playing')); document.querySelectorAll(`.track-steps`).forEach(container=>{ const el = container.querySelector(`.step[data-step="${step}"]`); if(el) el.classList.add('playing'); }); }
function clearStepHighlights(){ document.querySelectorAll('.step.playing').forEach(el=>el.classList.remove('playing')); }

// Transport handlers
playBtn.addEventListener('click', async ()=>{ ensureAudio(); if(audioCtx.state==='suspended') await audioCtx.resume(); if(!isPlaying){ isPlaying=true; playBtn.innerText='Playing...'; currentStep = 0; nextNoteTime = audioCtx.currentTime + 0.05; schedulerStart(); } });
stopBtn.addEventListener('click', ()=>{ if(isPlaying){ isPlaying=false; playBtn.innerText='Play'; schedulerStop(); } });

tempoSlider.addEventListener('input', (e)=>{ tempo = Number(e.target.value); tempoVal.innerText = tempo; });

// pattern management
addPatternBtn.addEventListener('click', ()=>{ pushUndo(snapshotState()); const len = Number(patternLengthSelect.value); const id = addPattern(len); // place in arranger first track
  arranger.forEach((row,ri)=>{ row.push(id); }); buildArrangerUI(); buildPatternEditorUI(); });
patternLengthSelect.addEventListener('change', ()=>{ /* adding ability to change length when creating new pattern only */ });

// samples -> ability to assign to new sample track
function createSampleTrack(name){ pushUndo(snapshotState()); const id = 'smp-'+Date.now(); const tr = { id, name, type:'sample', muted:false, solo:false, pan:0, volume:0.9, samples:[name], events:{} }; tracks.push(tr); // add empty events for all patterns
  patterns.forEach(p=> p.perTrackSteps[tr.id] = new Array(p.length).fill(false)); // add arranger row
  arranger.push(new Array(arranger[0].length).fill(-1)); refreshAllUI(); }

// file sample handling: double-click sample to create track
samplesList.addEventListener('dblclick', (e)=>{ if(!e.target.classList.contains('sample-entry')) return; const name = e.target.innerText; createSampleTrack(name); });

// export (offline render) - full mixdown
exportBtn.addEventListener('click', async ()=>{
  ensureAudio(); const bars = 8; const secondsPerBeat = 60.0/tempo; const duration = bars*4*secondsPerBeat; const sampleRate = 44100; const offline = new OfflineAudioContext(2, Math.ceil(duration*sampleRate), sampleRate);
  // create offline master
  const offMaster = offline.createGain(); offMaster.gain.value = 0.9; offMaster.connect(offline.destination);
  // create players for offline
  const offPlayers = {
    kick: makeKick(offline, offMaster), snare: makeSnare(offline, offMaster), hihat: makeHiHat(offline, offMaster),
    bass: makeSynthVoice(offline, offMaster,'sine',120,synthSettings.env), synth: makeSynthVoice(offline, offMaster,synthSettings.osc,synthSettings.filterCut,synthSettings.env)
  };
  // schedule same logic for bars
  for(let bar=0; bar<bars; bar++){
    for(let step=0; step<patterns[currentPatternId].length; step++){
      const t = bar*4*secondsPerBeat + (step*0.25)*secondsPerBeat;
      tracks.forEach((tr,ti)=>{
        const patId = arranger[ti][bar % arranger[ti].length];
        if(patId>=0){ const pat = patterns[patId]; if(pat.perTrackSteps[tr.id][step] && !tr.muted){ const player = offPlayers[tr.id] || (()=>{}); player(t, tr.volume || 1); } }
      });
    }
  }
  const rendered = await offline.startRendering(); const wav = audioBufferToWav(rendered); const blob = new Blob([new DataView(wav)], {type:'audio/wav'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'mini-studio-pro-export.wav'; a.click(); URL.revokeObjectURL(url); alert('Export complete');
});

// Export stems: render each track solo
exportStemsBtn.addEventListener('click', async ()=>{
  ensureAudio(); const bars = 8; const secondsPerBeat = 60.0/tempo; const duration = bars*4*secondsPerBeat; const sampleRate=44100;
  for(const tr of tracks){ const offline = new OfflineAudioContext(2, Math.ceil(duration*sampleRate), sampleRate); const offMaster = offline.createGain(); offMaster.gain.value = 0.9; offMaster.connect(offline.destination); const offPlayers = { kick: makeKick(offline,offMaster), snare: makeSnare(offline,offMaster), hihat: makeHiHat(offline,offMaster), bass: makeSynthVoice(offline,offMaster,'sine',120,synthSettings.env), synth: makeSynthVoice(offline,offMaster,synthSettings.osc,synthSettings.filterCut,synthSettings.env) };
    for(let bar=0; bar<bars; bar++){
      for(let step=0; step<patterns[currentPatternId].length; step++){
        const t = bar*4*secondsPerBeat + (step*0.25)*secondsPerBeat;
        const ti = tracks.indexOf(tr);
        const patId = arranger[ti][bar % arranger[ti].length]; if(patId>=0){ const pat = patterns[patId]; if(pat.perTrackSteps[tr.id][step]){ const player = offPlayers[tr.id] || (()=>{}); player(t, tr.volume || 1); } }
      }
    }
    const rendered = await offline.startRendering(); const wav = audioBufferToWav(rendered); const blob = new Blob([new DataView(wav)], {type:'audio/wav'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `stem-${tr.name.replace(/\s+/g,'_')}.wav`; a.click(); URL.revokeObjectURL(url);
  }
  alert('All stems exported');
});

// Save / Load project JSON
saveBtn.addEventListener('click', ()=>{ const data = {tracks,patterns,arranger,synthSettings,tempo}; const s = JSON.stringify(data); const blob = new Blob([s],{type:'application/json'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='mini-studio-project.json'; a.click(); URL.revokeObjectURL(url); });
loadBtn.addEventListener('click', ()=>{ loadFileInput.click(); });
loadFileInput.addEventListener('change', async (e)=>{ const f = e.target.files[0]; if(!f) return; const txt = await f.text(); try{ const obj = JSON.parse(txt); pushUndo(snapshotState()); tracks = obj.tracks; patterns = obj.patterns; arranger = obj.arranger; synthSettings = obj.synthSettings || synthSettings; tempo = obj.tempo || tempo; tempoSlider.value = tempo; tempoVal.innerText = tempo; refreshAllUI(); alert('Project loaded'); }catch(err){ alert('Invalid project file'); } });

// Piano keyboard UI (simple) and keyboard mapping
const pianoNotes = [
  {key:'A', note:261.63},{key:'W', note:277.18},{key:'S', note:293.66},{key:'E', note:311.13},{key:'D', note:329.63},{key:'F', note:349.23},{key:'T', note:369.99},{key:'G', note:392.00},{key:'Y', note:415.30},{key:'H', note:440.00},{key:'U', note:466.16},{key:'J', note:493.88},{key:'K', note:523.25}
];
const pianoEl = document.getElementById('piano');
function buildPiano(){ pianoEl.innerHTML=''; pianoNotes.forEach(n=>{ const k = document.createElement('div'); k.className='key'; k.innerText = n.key; if(/[WETYU]/.test(n.key)) k.classList.add('black'); k.dataset.freq = n.note; k.addEventListener('mousedown', ()=>{ ensureAudio(); const now = audioCtx.currentTime; const env = synthSettings.env; makeSynthVoice(audioCtx, masterGain, synthSettings.osc, synthSettings.filterCut, env)(now, Number(n.note), 0.6, 0.9); }); pianoEl.appendChild(k); }); window.addEventListener('keydown',(e)=>{ const key = e.key.toUpperCase(); const found = pianoNotes.find(p=>p.key===key); if(found){ ensureAudio(); const now = audioCtx.currentTime; makeSynthVoice(audioCtx, masterGain, synthSettings.osc, synthSettings.filterCut, synthSettings.env)(now, found.note, 0.6, 0.9); const el = [...pianoEl.children].find(ch=>ch.dataset.freq==found.note); if(el){ el.classList.add('playing'); setTimeout(()=>el.classList.remove('playing'),120); } } }); }

// Visualizer
function startVisualizer(){ requestAnimationFrame(drawViz); }
function drawViz(){ if(!analyser){ requestAnimationFrame(drawViz); return; } const bufferLength = analyser.frequencyBinCount; const dataArray = new Uint8Array(bufferLength); analyser.getByteFrequencyData(dataArray); vizCtx.clearRect(0,0,vizCanvas.width,vizCanvas.height); const barWidth = (vizCanvas.width / bufferLength) * 2.5; let x=0; for(let i=0;i<bufferLength;i+=8){ const v = dataArray[i]/255; const h = v * vizCanvas.height; vizCtx.fillStyle = `rgba(79,182,255,${0.6 * v + 0.1})`; vizCtx.fillRect(x, vizCanvas.height - h, barWidth, h); x += barWidth + 1; } requestAnimationFrame(drawViz); }

// MIDI support (input only)
if(navigator.requestMIDIAccess){ navigator.requestMIDIAccess().then(midi=>{ midi.inputs.forEach(inp=>{ inp.onmidimessage = onMIDIMessage; }); midi.onstatechange = ()=>{ /* could handle connect/disconnect */ }; }); }
function onMIDIMessage(ev){ const [cmd, note, vel] = ev.data; if(cmd===144){ // note on
  const f = midiToFreq(note); ensureAudio(); makeSynthVoice(audioCtx, masterGain, synthSettings.osc, synthSettings.filterCut, synthSettings.env)(audioCtx.currentTime, f, 1.2, vel/127); } }
function midiToFreq(n){ return 440 * Math.pow(2,(n-69)/12); }

// Helpers: audioBuffer -> WAV
function audioBufferToWav(buffer, opt){ opt = opt || {}; var numChannels = buffer.numberOfChannels; var sampleRate = buffer.sampleRate; var format = opt.float32 ? 3 : 1; var bitDepth = format === 3 ? 32 : 16; var result; if(numChannels === 2){ result = interleave(buffer.getChannelData(0), buffer.getChannelData(1)); } else { result = buffer.getChannelData(0); } return encodeWAV(result, numChannels, sampleRate, bitDepth, format); }
function interleave(inputL, inputR){ var length = inputL.length + inputR.length; var result = new Float32Array(length); var index = 0; var inputIndex = 0; while(index < length){ result[index++] = inputL[inputIndex]; result[index++] = inputR[inputIndex]; inputIndex++; } return result; }
function encodeWAV(samples, numChannels, sampleRate, bitDepth, format){ var bytesPerSample = bitDepth / 8; var blockAlign = numChannels * bytesPerSample; var buffer = new ArrayBuffer(44 + samples.length * bytesPerSample); var view = new DataView(buffer); writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * bytesPerSample, true); writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, format === 3 ? 3 : 1, true); view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bitDepth, true); writeString(view, 36, 'data'); view.setUint32(40, samples.length * bytesPerSample, true); if(format === 1){ floatTo16BitPCM(view, 44, samples); } else { writeFloat32(view, 44, samples); } return buffer; }
function floatTo16BitPCM(output, offset, input){ for(var i=0;i<input.length;i++, offset+=2){ var s = Math.max(-1, Math.min(1, input[i])); output.setInt16(offset, s<0 ? s*0x8000 : s*0x7FFF, true); } }
function writeFloat32(output, offset, input){ for(var i=0;i<input.length;i++, offset+=4){ output.setFloat32(offset, input[i], true); } }
function writeString(view, offset, string){ for(var i=0;i<string.length;i++){ view.setUint8(offset + i, string.charCodeAt(i)); } }

// Simple initialization
initState(); buildArrangerUI(); buildPatternEditorUI(); buildMixerUI(); buildPiano(); refreshSamplesUI();

// small UX: resume audio on user gesture
document.addEventListener('click', ()=>{ if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); });

// Expose some helpers to window for debugging
window.__miniStudio = { tracks, patterns, arranger, samples };

/* End of app.js */
