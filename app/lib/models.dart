/// What the API returns (see src/api/app-api.ts and src/domain/evaluation.ts on the server).
library;

class AppEvent {
  AppEvent({required this.id, required this.kind, this.text, this.data, this.media});

  factory AppEvent.fromJson(Map<String, dynamic> j) => AppEvent(
        id: j['id'] as int,
        kind: j['kind'] as String,
        text: j['text'] as String?,
        data: j['data'],
        media: j['media'] as String?,
      );

  final int id;
  final String kind; // text | voice | image | choice | evaluation
  final String? text;
  final dynamic data;
  final String? media;

  List<ChoiceOption> get options => [
        for (final o in ((data as Map<String, dynamic>?)?['options'] as List<dynamic>? ?? []))
          ChoiceOption.fromJson(o as Map<String, dynamic>),
      ];

  Evaluation? get evaluation =>
      kind == 'evaluation' && data is Map<String, dynamic> ? Evaluation.fromJson(data) : null;
}

class ChoiceOption {
  ChoiceOption(this.id, this.title, this.description);
  factory ChoiceOption.fromJson(Map<String, dynamic> j) =>
      ChoiceOption(j['id'] as String, j['title'] as String, (j['description'] as String?) ?? '');
  final String id;
  final String title;
  final String description;
}

class Mistake {
  Mistake(this.original, this.correction, this.type, this.explanation);
  factory Mistake.fromJson(Map<String, dynamic> j) => Mistake(
        j['original'] as String,
        j['correction'] as String,
        j['type'] as String,
        j['explanation'] as String,
      );
  final String original;
  final String correction;
  final String type;
  final String explanation;
}

class Evaluation {
  Evaluation({
    required this.transcript,
    required this.corrected,
    required this.score,
    required this.breakdown,
    required this.mistakes,
    required this.strengths,
    required this.tip,
  });

  factory Evaluation.fromJson(Map<String, dynamic> j) => Evaluation(
        transcript: j['transcript'] as String? ?? '',
        corrected: j['corrected'] as String? ?? '',
        score: (j['score'] as num?)?.toInt() ?? 0,
        breakdown: {
          for (final e in ((j['score_breakdown'] as Map<String, dynamic>?) ?? {}).entries)
            e.key: (e.value as num).toInt(),
        },
        mistakes: [
          for (final m in (j['mistakes'] as List<dynamic>? ?? []))
            Mistake.fromJson(m as Map<String, dynamic>),
        ],
        strengths: [for (final s in (j['strengths'] as List<dynamic>? ?? [])) s as String],
        tip: j['tip'] as String? ?? '',
      );

  final String transcript;
  final String corrected;
  final int score;
  final Map<String, int> breakdown;
  final List<Mistake> mistakes;
  final List<String> strengths;
  final String tip;
}

class Me {
  Me(this.json);
  factory Me.fromJson(dynamic j) => Me(j as Map<String, dynamic>);
  final Map<String, dynamic> json;

  String get name => (json['name'] as String?) ?? '';
  String get level => json['level'] as String;
  int get goal => json['goal'] as int;
  int get today => json['today'] as int;
  int get streak => json['streak'] as int;
  int get practices => json['practices'] as int;
  num? get averageScore => json['average_score'] as num?;
  bool get reminders => json['reminders'] as bool;
  String? get plan => (json['plan'] as Map<String, dynamic>?)?['name'] as String?;
  Map<String, dynamic> get course => (json['course'] as Map<String, dynamic>?) ?? {};
}
