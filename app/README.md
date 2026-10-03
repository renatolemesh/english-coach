# saybest app (Flutter)

O mesmo saybest do WhatsApp, como app: Android, iOS e web. Fala com a API `/app/v1` do servidor
(`../docs/multicanal.md`, `../src/api/app-api.ts`).

```bash
flutter pub get
flutter analyze && flutter test

# web (servido pela API em /app/: o compose monta app/build/web)
flutter build web --release --base-href /app/ --no-web-resources-cdn

# Android e iOS: o endereço da API vai no build
flutter build apk --release --dart-define=API_BASE=https://saybest.rlhtech.com.br
flutter build ipa --release --dart-define=API_BASE=https://saybest.rlhtech.com.br   # num Mac
```

- Login: telefone e senha do painel do aluno. Sessão: token guardado no aparelho.
- Áudio: Opus/WebM no Chrome, AAC no Safari, iOS e Android; a voz do tutor chega em MP3.
- Microfone: `RECORD_AUDIO` (Android) e `NSMicrophoneUsageDescription` (iOS) já declarados.
