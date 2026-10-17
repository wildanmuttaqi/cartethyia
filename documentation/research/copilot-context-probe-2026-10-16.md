# Copilot context probe, 2026-10-16

Diukur langsung ke `api.individual.githubcopilot.com`, tanpa gateway, dari
akun Individual. Token tidak dicatat di sini. Ulangi dengan kredensial akun
yang sama: dekripsi `provider_accounts.credential_ciphertext` untuk
`provider_id = 'github'`, layoutnya `iv(12) + tag(16) + ciphertext`.

## Cara request

Dua langkah. `/auto` memilih model dan memberi session token. Inference
memakai token itu.

```text
POST https://api.individual.githubcopilot.com/auto
{"prompt": "Reply pong.", "tier": "efficiency" | "balance" | "intelligence"}

-> {"selected_model": {...}, "session_token": "..."}
```

```text
POST https://api.individual.githubcopilot.com/responses
Copilot-Session-Token: <session_token>
{"model": "<selected_model.id>", "input": [{"role": "user", "content": "..."}],
 "max_output_tokens": 16, "stream": false}
```

`gpt-6-luna` dan `mai-code-1.1-flash` menolak `model_not_supported` kalau
dipanggil tanpa session token. Keduanya hanya hidup di dalam sesi auto.

## Header

Semua request, kedua langkah:

```text
authorization: Bearer <copilot access token>
content-type: application/json
user-agent: GitHubCopilotChat/0.70.0
editor-version: vscode/1.142.0
editor-plugin-version: copilot-chat/0.70.0
copilot-integration-id: vscode-chat
openai-intent: conversation-agent
x-initiator: user
x-interaction-type: conversation-agent
x-github-api-version: 2026-08-01
x-request-id: <unik per request>
```

Inference menambah `Copilot-Session-Token`. HTTP tidak membedakan huruf, tapi bundle menulisnya persis begitu.

`x-github-api-version` terbukti, bukan diasumsikan:

| Endpoint | `2026-01-09` | `2026-08-01` |
|---|---|---|
| `/chat/completions` (gpt-4o-mini) | 200 | 200 |
| `/responses` (gpt-6-luna, tanpa sesi) | 400 model_not_supported | 400 model_not_supported |
| `/auto` | 404 `invalid apiVersion` | 200 |

`2026-01-09` yang ada di satu jalur bundle Copilot Chat 0.70.0 ditolak oleh
`/auto`. `2026-08-01` diterima.

## Model yang auto pilih

| Tier | Model | Context katalog | Batas prompt yang diberlakukan |
|---|---|---|---|
| efficiency | gpt-6-luna | 1.000.000 | 872.000 (belum teruji, lihat bawah) |
| balance | mai-code-1.1-flash | 256.000 | 128.000 |
| intelligence | mai-code-1.1-flash | 256.000 | 128.000 |

Output mai-flash 128.000, jadi context 256.000 = prompt 128.000 + output
128.000. Luna output 128.000, dan 1.000.000 − 128.000 = 872.000, cocok dengan
`max_prompt_tokens` yang katalog laporkan.

## Batas prompt mai-flash, satu sesi

Sesi `intelligence`, model `mai-code-1.1-flash`, prompt diisi pengulangan
`alpha `.

| Karakter | Token prompt | Hasil |
|---|---|---|
| 100.000 | 16.676 | lolos |
| 400.000 | 66.676 | lolos |
| 700.000 | 116.676 | lolos |
| 760.000 | 126.676 | lolos |
| 768.000 | 128.004 | 400 `prompt token count of 128004 exceeds the limit of 128000` |
| 770.000 | 128.337 | 400, batas yang sama |

Compact diminta tepat di 128.000 token prompt. Tidak ada field tambahan yang
perlu dikirim untuk mendapat batas itu.

## Luna

Sesi `efficiency`, prompt `Halo haii!`, memilih `gpt-6-luna`. Request pendek
berhasil. Prompt besar ditolak `503 model_overloaded`, dan batasnya tajam,
jadi ini bukan model sibuk:

| Karakter | Token prompt | Hasil |
|---|---|---|
| 30.000 | 5.010 | lolos |
| 35.000 | 5.843 | lolos |
| 36.000 | 6.010 | lolos |
| 36.500 | 6.093 | lolos |
| 37.000 | — | 503 `model_overloaded` |
| 40.000 dan seterusnya | — | 503 yang sama |

Itu batas request sekali kirim dengan isi berulang. Percakapan yang tumbuh
berbeda: setiap giliran mengirim ulang seluruh history, `stream: true`,
`store: false`. Token naik 4.820 per giliran (4.815, 9.635, 14.455, …) dan
server tidak pernah meminta compact. Satu request 200.000 kata lolos di
800.010 token. 218.000 kata ditolak: `prompt token count of 872004 exceeds
the limit of 872000`. Plafon yang diberlakukan persis `max_prompt_tokens`
katalog, bukan 6.000.

Bundle tidak mengalihkan saat overload. `model_overloaded` hanya dipetakan ke
pesan "high demand". Cache auto dibatalkan hanya setelah percakapan di-compact
(`invalidateRouterCache`), lalu request berikutnya memilih model baru. Tidak
ada re-route di tengah request.

Session token juga bukan memori percakapan, termasuk saat streaming.
Tiga request `stream: true` berturut-turut, masing-masing 45.000 karakter
dengan isi berbeda, memakai token yang sama, melaporkan `input_tokens: 15009`
setiap giliran. Angkanya tidak naik. Bundle mengirim `store: false`, jadi
server tidak menyimpan giliran. Compact terjadi di klien.

## Compact dan re-route di VS Code

Keduanya keputusan klien, bukan respons server.

Compact: sebelum mengirim, VS Code menghitung token seluruh history
(`_getFinalElementTree`). Anggaran dasarnya `modelMaxPromptTokens`, atau
`contextSize` kalau sesi punya yang lebih kecil. Tool ikut dihitung, lalu
anggaran akhir adalah `floor((anggaran - token tool) × 0.9)`. Kalau history
melewatinya, node prioritas terendah dibuang sampai muat
(`removeLowestPriorityChild`). Tidak ada sinyal dari server. Makanya pindah
ke sesi yang history-nya sudah penuh langsung minta compact: VS Code
menghitungnya sebelum request pertama sesi itu dikirim.

Re-route: setiap giliran baru memanggil `/auto` lagi, kecuali cache percakapan
masih berlaku. Cache dianggap berlaku hanya kalau tiga hal ini semua benar:
tier sama, session token belum lewat `expires_at`, dan request bergambar tidak
diarahkan ke model tanpa vision (`_isCacheEntryCompatible`). Cache dibatalkan
paksa setelah compact (`invalidateRouterCache`). Di luar itu, setiap giliran
menunggu `/auto` sebelum inference — itulah jeda di awal setiap balasan, dan
bukan karena server menumpuk sesi.

## gpt-4o, pembanding

Dipanggil langsung ke `/chat/completions`, tanpa sesi. Katalog melaporkan
context 128.000 dan output 16.384, tapi batas yang diberlakukan 64.000:

| Karakter | Token prompt | Hasil |
|---|---|---|
| 380.000 | 63.344 | lolos |
| 383.000 | 63.844 | lolos |
| 384.000 | 64.011 | 400 `exceeds the limit of 64000` |

Jangan percaya `max_context_window_tokens` sebagai batas prompt. Yang
diberlakukan adalah `max_prompt_tokens`, dan untuk model lama angka itu lebih
kecil dari context window dikurangi output.
