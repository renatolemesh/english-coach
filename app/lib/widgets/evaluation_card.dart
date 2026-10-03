/// The evaluation the WhatsApp channels get as a PNG card, drawn natively.
library;

import 'package:flutter/material.dart';

import '../models.dart';

const _labels = {
  'grammar': 'Gramática',
  'vocabulary': 'Vocabulário',
  'fluency': 'Fluência',
  'task': 'Resposta ao tema',
};

class EvaluationCard extends StatelessWidget {
  const EvaluationCard(this.evaluation, {super.key, this.caption});
  final Evaluation evaluation;
  final String? caption;

  Color _scoreColor(int score, ColorScheme c) =>
      score >= 80 ? const Color(0xFF0F9F8C) : (score >= 60 ? const Color(0xFFF5B83D) : c.error);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = theme.colorScheme;
    final e = evaluation;
    return Card(
      elevation: 0,
      color: c.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Text('${e.score}',
                  style: theme.textTheme.displaySmall
                      ?.copyWith(fontWeight: FontWeight.w800, color: _scoreColor(e.score, c))),
              Text(' /100', style: theme.textTheme.titleMedium?.copyWith(color: c.outline)),
            ]),
            const SizedBox(height: 8),
            for (final entry in e.breakdown.entries) ...[
              Text('${_labels[entry.key] ?? entry.key}  ${entry.value}',
                  style: theme.textTheme.bodySmall),
              const SizedBox(height: 2),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: entry.value / 100,
                  minHeight: 6,
                  color: _scoreColor(entry.value, c),
                  backgroundColor: c.surfaceContainerHighest,
                ),
              ),
              const SizedBox(height: 6),
            ],
            const Divider(height: 24),
            _Section('Você disse', Text(e.transcript)),
            if (e.mistakes.isNotEmpty)
              _Section(
                'Para corrigir',
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final m in e.mistakes)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text.rich(TextSpan(children: [
                            TextSpan(
                                text: m.original,
                                style: TextStyle(
                                    decoration: TextDecoration.lineThrough, color: c.error)),
                            const TextSpan(text: '  →  '),
                            TextSpan(
                                text: m.correction,
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700, color: Color(0xFF0B7F70))),
                          ])),
                          Text(m.explanation, style: theme.textTheme.bodySmall),
                        ]),
                      ),
                  ],
                ),
              ),
            if (e.corrected.isNotEmpty && e.corrected != e.transcript)
              _Section('Do jeito certo', Text(e.corrected, style: const TextStyle(fontWeight: FontWeight.w600))),
            if (e.strengths.isNotEmpty)
              _Section('Mandou bem', Text(e.strengths.map((s) => '• $s').join('\n'))),
            if (e.tip.isNotEmpty) _Section('Dica', Text(e.tip)),
            if (caption != null && caption!.contains('\n'))
              Text(caption!.split('\n').skip(1).join('\n').trim(),
                  style: theme.textTheme.bodySmall?.copyWith(color: c.outline)),
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.child);
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title.toUpperCase(),
              style: Theme.of(context)
                  .textTheme
                  .labelSmall
                  ?.copyWith(letterSpacing: 1.1, color: Theme.of(context).colorScheme.outline)),
          const SizedBox(height: 4),
          child,
        ]),
      );
}
