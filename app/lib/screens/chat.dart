/// The conversation: the same flow as on WhatsApp (voice answers, the evaluation, the tutor's
/// voice, buttons for menus and lessons), with what the bot sends fetched as events.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../api.dart';
import '../models.dart';
import '../recording.dart';
import '../widgets/evaluation_card.dart';
import '../widgets/rich.dart';
import '../widgets/voice_bubble.dart';
import 'progress.dart';

/// A line in the conversation: something the bot sent, or what the student just sent.
class _Item {
  _Item.event(this.event, {this.live = false}) : mine = null;
  _Item.mine(this.mine)
      : event = null,
        live = false;
  final AppEvent? event;
  final String? mine;
  final bool live; // arrived while the app was open: the voice plays by itself
}

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.api, required this.onLogout});
  final Api api;
  final VoidCallback onLogout;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _items = <_Item>[];
  final _answered = <int>{}; // choice events already tapped
  final _text = TextEditingController();
  final _scroll = ScrollController();
  final _recorder = AudioRecorder();
  int _lastId = 0;
  bool _stopped = false;
  bool _waiting = false; // a message is on its way: show "writing..."
  bool _recording = false;
  DateTime? _recordStart;
  Timer? _tick;
  String _mime = 'audio/webm';

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _stopped = true;
    _tick?.cancel();
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    try {
      final history = await widget.api.recent();
      setState(() => _items.addAll(history.map(_Item.event)));
      if (history.isNotEmpty) _lastId = history.last.id;
      _toBottom();
      if (history.isEmpty) await _send(text: 'oi'); // first time: the welcome and a question
    } on ApiError catch (e) {
      if (e.unauthorized) return widget.onLogout();
    } catch (_) {}
    unawaited(_poll());
  }

  Future<void> _poll() async {
    while (!_stopped) {
      try {
        final events = await widget.api.events(after: _lastId);
        if (_stopped || events.isEmpty) continue;
        setState(() {
          _items.addAll(events.map((e) => _Item.event(e, live: true)));
          _lastId = events.last.id;
          _waiting = false;
        });
        _toBottom();
      } on ApiError catch (e) {
        if (e.unauthorized) return widget.onLogout();
        await Future<void>.delayed(const Duration(seconds: 3));
      } catch (_) {
        await Future<void>.delayed(const Duration(seconds: 3)); // offline: try again
      }
    }
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _send({String? text, ChoiceOption? option, int? choiceEvent}) async {
    final shown = option?.title ?? text ?? '';
    setState(() {
      _items.add(_Item.mine(shown));
      if (choiceEvent != null) _answered.add(choiceEvent);
      _waiting = true;
    });
    _toBottom();
    try {
      if (option != null) {
        await widget.api.sendOption(option.id);
      } else {
        await widget.api.sendText(text!);
      }
    } catch (_) {
      _failed();
    }
  }

  void _failed() {
    setState(() => _waiting = false);
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Não deu para enviar. Confira a internet e tente de novo.')));
  }

  Future<void> _toggleRecording() async {
    if (_recording) return _finishRecording();
    if (!await _recorder.hasPermission()) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Permita o microfone para mandar áudio.')));
      return;
    }
    // what each platform records well: Opus/WebM in Chrome, AAC in Safari, iOS and Android
    var encoder = AudioEncoder.aacLc;
    _mime = 'audio/mp4';
    if (kIsWeb && await _recorder.isEncoderSupported(AudioEncoder.opus)) {
      encoder = AudioEncoder.opus;
      _mime = 'audio/webm';
    }
    final path = kIsWeb ? '' : '${(await getTemporaryDirectory()).path}/saybest-answer.m4a';
    await _recorder.start(RecordConfig(encoder: encoder, numChannels: 1), path: path);
    setState(() {
      _recording = true;
      _recordStart = DateTime.now();
    });
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  Future<void> _finishRecording() async {
    _tick?.cancel();
    final path = await _recorder.stop();
    final seconds = DateTime.now().difference(_recordStart ?? DateTime.now()).inSeconds;
    setState(() => _recording = false);
    if (path == null || seconds < 1) return;
    setState(() {
      _items.add(_Item.mine('🎙️ Áudio de ${seconds}s'));
      _waiting = true;
    });
    _toBottom();
    try {
      final bytes = await recordingBytes(path);
      final ext = _mime == 'audio/webm' ? 'webm' : 'm4a';
      await widget.api.sendAudio(bytes, _mime, 'answer.$ext');
    } catch (_) {
      _failed();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('saybest', style: TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          IconButton(
            tooltip: 'Aula rápida',
            icon: const Icon(Icons.school_outlined),
            onPressed: () => _send(text: '/aula'),
          ),
          IconButton(
            tooltip: 'Seu progresso',
            icon: const Icon(Icons.insights_outlined),
            onPressed: () async {
              final command = await Navigator.of(context).push<String>(MaterialPageRoute(
                  builder: (_) => ProgressScreen(api: widget.api, onLogout: widget.onLogout)));
              if (command != null) _send(text: command);
            },
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Column(children: [
            Expanded(
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.all(12),
                itemCount: _items.length + (_waiting ? 1 : 0),
                itemBuilder: (context, i) {
                  if (i == _items.length) return const _Typing();
                  return _line(_items[i], c);
                },
              ),
            ),
            _inputBar(c),
          ]),
        ),
      ),
    );
  }

  Widget _line(_Item item, ColorScheme c) {
    final mine = item.mine;
    if (mine != null) {
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: const BoxConstraints(maxWidth: 520),
          decoration: BoxDecoration(color: c.primaryContainer, borderRadius: BorderRadius.circular(18)),
          child: Text(mine),
        ),
      );
    }
    final e = item.event!;
    final Widget body = switch (e.kind) {
      'evaluation' when e.evaluation != null => EvaluationCard(e.evaluation!, caption: e.text),
      'voice' when e.media != null =>
        VoiceBubble(widget.api.mediaUrl(e.media!), autoplay: item.live, key: ValueKey(e.id)),
      'image' when e.media != null => ClipRRect(
          borderRadius: BorderRadius.circular(16), child: Image.network(widget.api.mediaUrl(e.media!))),
      'choice' => _choice(e, c),
      _ => _bubble(e.text ?? '', c),
    };
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560), child: body),
      ),
    );
  }

  Widget _bubble(String text, ColorScheme c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: c.surfaceContainerHigh, borderRadius: BorderRadius.circular(18)),
        child: WhatsappText(text),
      );

  Widget _choice(AppEvent e, ColorScheme c) {
    final done = _answered.contains(e.id) || e.id < _lastLiveChoice();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if ((e.text ?? '').isNotEmpty) _bubble(e.text!, c),
      const SizedBox(height: 6),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final o in e.options)
          FilledButton.tonal(
            onPressed: done ? null : () => _send(option: o, choiceEvent: e.id),
            child: Text(o.description.isEmpty ? o.title : '${o.title} · ${o.description}'),
          ),
      ]),
    ]);
  }

  /// Only the latest set of buttons can be tapped (old ones belong to finished questions).
  int _lastLiveChoice() {
    for (final item in _items.reversed) {
      if (item.event?.kind == 'choice') return item.event!.id;
    }
    return 0;
  }

  Widget _inputBar(ColorScheme c) {
    final seconds = _recording ? DateTime.now().difference(_recordStart!).inSeconds : 0;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
        child: Row(children: [
          Expanded(
            child: _recording
                ? Text('🔴 Gravando… ${seconds}s  (toque de novo para enviar)',
                    style: TextStyle(color: c.error))
                : TextField(
                    controller: _text,
                    minLines: 1,
                    maxLines: 4,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _submitText(),
                    decoration: InputDecoration(
                      hintText: 'Responda em inglês… ou grave um áudio',
                      filled: true,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    ),
                  ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            iconSize: 28,
            tooltip: _recording ? 'Enviar áudio' : 'Gravar áudio',
            style: IconButton.styleFrom(backgroundColor: _recording ? c.error : c.primary),
            icon: Icon(_recording ? Icons.send : Icons.mic),
            onPressed: _toggleRecording,
          ),
          if (!_recording)
            IconButton(tooltip: 'Enviar texto', icon: const Icon(Icons.send), onPressed: _submitText),
        ]),
      ),
    );
  }

  void _submitText() {
    final text = _text.text.trim();
    if (text.isEmpty) return;
    _text.clear();
    _send(text: text);
  }
}

class _Typing extends StatelessWidget {
  const _Typing();

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: 10),
          Text('Corrigindo e preparando a resposta…',
              style: TextStyle(color: Theme.of(context).colorScheme.outline)),
        ]),
      );
}
