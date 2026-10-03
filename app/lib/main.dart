import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/chat.dart';
import 'screens/login.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(SaybestApp(api: await Api.load()));
}

class SaybestApp extends StatefulWidget {
  const SaybestApp({super.key, required this.api});
  final Api api;

  @override
  State<SaybestApp> createState() => _SaybestAppState();
}

class _SaybestAppState extends State<SaybestApp> {
  late bool _loggedIn = widget.api.loggedIn;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'saybest',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF0F9F8C),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: const Color(0xFF0F9F8C),
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: _loggedIn
          ? ChatScreen(api: widget.api, onLogout: () => setState(() => _loggedIn = false))
          : LoginScreen(api: widget.api, onLogin: () => setState(() => _loggedIn = true)),
    );
  }
}
