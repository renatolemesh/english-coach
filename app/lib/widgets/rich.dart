/// The bot writes like WhatsApp: *bold*, _italic_, ~strike~. Turn that into text spans.
library;

import 'package:flutter/material.dart';

final _mark = RegExp(r'\*([^*\n]+)\*|(?<=^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])|~([^~\n]+)~');

List<InlineSpan> whatsappSpans(String text, TextStyle base) {
  final spans = <InlineSpan>[];
  var at = 0;
  for (final m in _mark.allMatches(text)) {
    if (m.start > at) spans.add(TextSpan(text: text.substring(at, m.start)));
    if (m.group(1) != null) {
      spans.add(TextSpan(text: m.group(1), style: const TextStyle(fontWeight: FontWeight.w700)));
    } else if (m.group(2) != null) {
      spans.add(TextSpan(text: m.group(2), style: const TextStyle(fontStyle: FontStyle.italic)));
    } else {
      spans.add(TextSpan(
          text: m.group(3), style: const TextStyle(decoration: TextDecoration.lineThrough)));
    }
    at = m.end;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return spans;
}

class WhatsappText extends StatelessWidget {
  const WhatsappText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final base = style ?? DefaultTextStyle.of(context).style;
    return SelectableText.rich(TextSpan(style: base, children: whatsappSpans(text, base)));
  }
}
