# Mini Studio Pro

Mini Studio Pro adalah DAW (digital audio workstation) sederhana yang berjalan 100% di browser menggunakan HTML/CSS/JS dan Web Audio API.

Fitur utama:
- Arranger & Pattern editor (multi-pattern)
- Synth dengan ADSR dan filter (poly-like voices)
- Drum synth (kick/snare/hihat)
- Sample library (drag & drop atau pilih file)
- Mic recording (rekam langsung dan masukkan sebagai sample)
- Mixer dengan volume/mute/solo
- MIDI input (note on => synth)
- Offline mixdown export (WAV) dan stem export per-track
- Save / Load project (JSON)

Cara pakai singkat:
1. Clone atau download ZIP dari repo.
2. Buka index.html di browser modern (Chrome/Edge direkomendasikan).
3. Gunakan tombol Play/Stop, atur tempo, buat pola baru, klik langkah di Pattern Editor.
4. Drag & drop file audio ke panel Library untuk menambah sample. Double klik sample untuk membuat track sample.
5. Tekan Record (Mic) untuk merekam dari mikrofon ke sample.
6. Export WAV untuk mixdown, atau Export Stems untuk setiap track.

Catatan teknis dan batasan:
- Implementasi efek masih sederhana (tidak ada convolution reverb). Reverb/delay bisa ditingkatkan.
- Offline export menggunakan OfflineAudioContext; beberapa browser memiliki batasan untuk durasi dan sample rate.
- Saya telah mencoba menjaga kode modular dan mudah dibaca; jika Anda ingin penambahan (automation, per-step velocity, GUI polishing), beri tahu saya.

Lisensi: MIT
