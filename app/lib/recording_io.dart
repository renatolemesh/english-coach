import 'dart:io';

Future<List<int>> recordingBytes(String path) async {
  final file = File(path);
  final bytes = await file.readAsBytes();
  await file.delete().catchError((Object _) => file);
  return bytes;
}
