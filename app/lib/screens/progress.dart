/// Progress and settings: today's goal, streak, lessons, level. Pops with a command to send
/// (the lesson buttons) or nothing.
library;

import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';

const _levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

class ProgressScreen extends StatefulWidget {
  const ProgressScreen({super.key, required this.api, required this.onLogout});
  final Api api;
  final VoidCallback onLogout;

  @override
  State<ProgressScreen> createState() => _ProgressScreenState();
}

class _ProgressScreenState extends State<ProgressScreen> {
  Me? _me;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final me = await widget.api.me();
      if (mounted) setState(() => _me = me);
    } on ApiError catch (e) {
      if (e.unauthorized) {
        if (mounted) Navigator.of(context).pop();
        return widget.onLogout();
      }
      setState(() => _error = 'Não deu para carregar agora.');
    } catch (_) {
      setState(() => _error = 'Sem conexão com o saybest.');
    }
  }

  Future<void> _save(Map<String, Object?> values) async {
    try {
      await widget.api.saveSettings(values);
      await _load();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Não deu para salvar.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = _me;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Seu progresso')),
      body: me == null
          ? Center(child: _error == null ? const CircularProgressIndicator() : Text(_error!))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 560),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      Text(me.name.isEmpty ? 'Olá!' : 'Olá, ${me.name.split(' ').first}!',
                          style: theme.textTheme.headlineSmall),
                      const SizedBox(height: 16),
                      _Tile(
                        icon: Icons.flag_outlined,
                        title: 'Meta de hoje: ${me.today} de ${me.goal}',
                        child: LinearProgressIndicator(
                            value: me.goal == 0 ? 0 : (me.today / me.goal).clamp(0, 1),
                            minHeight: 8,
                            borderRadius: BorderRadius.circular(4)),
                      ),
                      _Tile(icon: Icons.local_fire_department_outlined, title: 'Sequência: ${me.streak} dia(s)'),
                      _Tile(
                        icon: Icons.mic_none,
                        title: '${me.practices} práticas'
                            '${me.averageScore != null ? ' · nota média ${me.averageScore!.round()}' : ''}',
                      ),
                      _Tile(
                        icon: Icons.school_outlined,
                        title: '${me.course['lessons'] ?? 0} aulas · ${me.course['words'] ?? 0} palavras'
                            '${(me.course['due'] ?? 0) > 0 ? ' · ${me.course['due']} revisões esperando' : ''}',
                      ),
                      if (me.plan != null) _Tile(icon: Icons.workspace_premium_outlined, title: 'Plano: ${me.plan}'),
                      const SizedBox(height: 12),
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        FilledButton.icon(
                            icon: const Icon(Icons.play_arrow),
                            label: const Text('Aula rápida'),
                            onPressed: () => Navigator.of(context).pop('/aula')),
                        FilledButton.tonalIcon(
                            icon: const Icon(Icons.replay),
                            label: const Text('Revisar'),
                            onPressed: () => Navigator.of(context).pop('/revisar')),
                        OutlinedButton.icon(
                            icon: const Icon(Icons.quiz_outlined),
                            label: const Text('Teste de nível'),
                            onPressed: () => Navigator.of(context).pop('/teste')),
                      ]),
                      const Divider(height: 40),
                      Text('Configurações', style: theme.textTheme.titleMedium),
                      const SizedBox(height: 8),
                      DropdownButtonFormField<String>(
                        initialValue: me.level,
                        decoration: const InputDecoration(labelText: 'Nível', border: OutlineInputBorder()),
                        items: [for (final l in _levels) DropdownMenuItem(value: l, child: Text(l))],
                        onChanged: (v) => v == null ? null : _save({'level': v}),
                      ),
                      const SizedBox(height: 12),
                      Text('Meta diária: ${me.goal} práticas'),
                      Slider(
                        value: me.goal.toDouble().clamp(1, 30),
                        min: 1,
                        max: 30,
                        divisions: 29,
                        label: '${me.goal}',
                        onChanged: (_) {},
                        onChangeEnd: (v) => _save({'daily_goal': v.round()}),
                      ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title: const Text('Lembrete quando a meta do dia não sair'),
                        value: me.reminders,
                        onChanged: (v) => _save({'reminders': v}),
                      ),
                      const SizedBox(height: 24),
                      TextButton.icon(
                        icon: const Icon(Icons.logout),
                        label: const Text('Sair'),
                        onPressed: () async {
                          await widget.api.logout();
                          if (context.mounted) Navigator.of(context).pop();
                          widget.onLogout();
                        },
                      ),
                    ]),
                  ),
                ),
              ],
            ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.icon, required this.title, this.child});
  final IconData icon;
  final String title;
  final Widget? child;

  @override
  Widget build(BuildContext context) => Card(
        elevation: 0,
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        child: ListTile(leading: Icon(icon), title: Text(title), subtitle: child),
      );
}
