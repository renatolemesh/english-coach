import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:saybest/widgets/rich.dart';

String flat(List<InlineSpan> spans) => spans.map((s) => (s as TextSpan).text).join('|');

void main() {
  test('WhatsApp marks become spans; gaps and snake_case stay as text', () {
    const base = TextStyle();
    expect(flat(whatsappSpans('*1/10*\nO que *able* significa?', base)), '1/10|\nO que |able| significa?');
    expect(flat(whatsappSpans('Tradução: _Espero que não._', base)), 'Tradução: |Espero que não.');
    expect(flat(whatsappSpans('work ___ system', base)), 'work ___ system');
    expect(flat(whatsappSpans('snake_case_word', base)), 'snake_case_word');
  });
}
