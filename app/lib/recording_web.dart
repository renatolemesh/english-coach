import 'package:http/http.dart' as http;

Future<List<int>> recordingBytes(String path) async => (await http.get(Uri.parse(path))).bodyBytes;
