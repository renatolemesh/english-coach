/// The bytes of a finished recording: a blob URL on the web, a file on Android and iOS.
library;

export 'recording_io.dart' if (dart.library.js_interop) 'recording_web.dart';
