/// The tutor's voice note: play/pause with a progress bar.
library;

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';

class VoiceBubble extends StatefulWidget {
  const VoiceBubble(this.url, {super.key, this.autoplay = false});
  final String url;
  final bool autoplay;

  @override
  State<VoiceBubble> createState() => _VoiceBubbleState();
}

class _VoiceBubbleState extends State<VoiceBubble> {
  final _player = AudioPlayer();
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _player.setUrl(widget.url).then((_) {
      if (!mounted) return;
      setState(() => _ready = true);
      if (widget.autoplay) _player.play();
    }).catchError((Object _) {});
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Container(
      width: 260,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(color: c.surfaceContainerLow, borderRadius: BorderRadius.circular(20)),
      child: StreamBuilder<PlayerState>(
        stream: _player.playerStateStream,
        builder: (context, snap) {
          final playing = snap.data?.playing ?? false;
          final done = snap.data?.processingState == ProcessingState.completed;
          return Row(children: [
            IconButton(
              icon: Icon(playing && !done ? Icons.pause_circle_filled : Icons.play_circle_fill,
                  color: c.primary, size: 36),
              onPressed: !_ready
                  ? null
                  : () async {
                      if (done) await _player.seek(Duration.zero);
                      playing && !done ? _player.pause() : _player.play();
                    },
            ),
            Expanded(
              child: StreamBuilder<Duration>(
                stream: _player.positionStream,
                builder: (context, pos) {
                  final total = _player.duration?.inMilliseconds ?? 0;
                  final at = pos.data?.inMilliseconds ?? 0;
                  return LinearProgressIndicator(
                    value: total > 0 ? (at / total).clamp(0, 1) : 0,
                    minHeight: 4,
                    borderRadius: BorderRadius.circular(2),
                  );
                },
              ),
            ),
            const SizedBox(width: 8),
          ]);
        },
      ),
    );
  }
}
