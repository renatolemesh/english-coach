/// The saybest API (/app/v1, docs/multicanal.md in the server repo).
///
/// On the web the app is served by the same site, so the API is the page's own origin. Mobile
/// builds get the address at build time: --dart-define=API_BASE=https://saybest.rlhtech.com.br
library;

import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;
import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

const _define = String.fromEnvironment('API_BASE');
const _tokenKey = 'saybest_token';

class ApiError implements Exception {
  ApiError(this.status);
  final int status;
  bool get unauthorized => status == 401;
  @override
  String toString() => 'ApiError($status)';
}

class Api {
  Api._(this.base, this._prefs);

  final String base;
  final SharedPreferences _prefs;
  final http.Client _http = http.Client();

  static Future<Api> load() async {
    final base = _define.isNotEmpty ? _define : (kIsWeb ? Uri.base.origin : 'https://saybest.rlhtech.com.br');
    return Api._(base, await SharedPreferences.getInstance());
  }

  String? get token => _prefs.getString(_tokenKey);
  bool get loggedIn => token != null;

  Uri _url(String path, [Map<String, String>? query]) =>
      Uri.parse('$base/app/v1$path').replace(queryParameters: query);

  Map<String, String> get _auth => {'authorization': 'Bearer $token'};

  Future<dynamic> _json(http.Response r) async {
    if (r.statusCode == 401) await _prefs.remove(_tokenKey);
    if (r.statusCode >= 300) throw ApiError(r.statusCode);
    return jsonDecode(utf8.decode(r.bodyBytes));
  }

  Future<void> login(String phone, String password) async {
    final r = await _http.post(
      _url('/auth/login'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'phone': phone, 'password': password}),
    );
    final data = await _json(r) as Map<String, dynamic>;
    await _prefs.setString(_tokenKey, data['token'] as String);
  }

  Future<void> logout() async {
    try {
      await _http.post(_url('/auth/logout'), headers: _auth);
    } finally {
      await _prefs.remove(_tokenKey);
    }
  }

  Future<Me> me() async => Me.fromJson(await _json(await _http.get(_url('/me'), headers: _auth)));

  Future<void> saveSettings(Map<String, Object?> values) async {
    await _json(await _http.patch(
      _url('/me/settings'),
      headers: {..._auth, 'content-type': 'application/json'},
      body: jsonEncode(values),
    ));
  }

  Future<void> sendText(String text) => _post({'text': text});

  /// A tapped button: the server turns its id into the command, like on WhatsApp.
  Future<void> sendOption(String id) => _post({'option': id});

  Future<void> _post(Map<String, String> body) async {
    await _json(await _http.post(
      _url('/messages'),
      headers: {..._auth, 'content-type': 'application/json'},
      body: jsonEncode(body),
    ));
  }

  Future<void> sendAudio(List<int> bytes, String mime, String filename) async {
    final request = http.MultipartRequest('POST', _url('/messages'))
      ..headers.addAll(_auth)
      ..files.add(http.MultipartFile.fromBytes('audio', bytes,
          filename: filename, contentType: MediaType.parse(mime.split(';').first)));
    await _json(await http.Response.fromStream(await _http.send(request)));
  }

  /// Events after [after], waiting up to [wait] seconds for the first one.
  Future<List<AppEvent>> events({int after = 0, int wait = 25}) async {
    final data = await _json(await _http.get(
      _url('/events', {'after': '$after', 'wait': '$wait'}),
      headers: _auth,
    ));
    return _events(data);
  }

  /// The last [count] events: the conversation so far, when the app opens.
  Future<List<AppEvent>> recent({int count = 50}) async =>
      _events(await _json(await _http.get(_url('/events', {'recent': '$count'}), headers: _auth)));

  List<AppEvent> _events(dynamic data) => [
        for (final e in (data as Map<String, dynamic>)['events'] as List<dynamic>)
          AppEvent.fromJson(e as Map<String, dynamic>),
      ];

  String mediaUrl(String path) => '$base$path';
}
