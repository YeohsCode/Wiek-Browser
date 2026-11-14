import Foundation
import NaturalLanguage

struct Document: Decodable { let title: String; let text: String }
struct Search: Decodable { let query: String; let documents: [Document] }
struct Match: Encodable { let index: Int; let offset: Int; let score: Double }

do {
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    guard bytes.count <= 48 * 1024 * 1024 else { exit(2) }
    let search = try JSONDecoder().decode(Search.self, from: bytes)
    guard search.documents.count <= 512, search.query.utf8.count <= 512 else { exit(2) }
    func languageOf(_ text: String) -> NLLanguage? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        return recognizer.dominantLanguage
    }
    guard let language = languageOf(search.query),
          let embedding = NLEmbedding.sentenceEmbedding(for: language),
          let query = embedding.vector(for: search.query) else { exit(3) }
    func similarity(_ text: String) -> Double {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              languageOf(text) == language,
              let vector = embedding.vector(for: text), vector.count == query.count else { return 0 }
        var dot = 0.0, lhs = 0.0, rhs = 0.0
        for (a, b) in zip(vector, query) { dot += a * b; lhs += a * a; rhs += b * b }
        let norm = sqrt(lhs * rhs)
        return norm > 0 ? dot / norm : 0
    }
    var matches: [Match] = []
    for (index, doc) in search.documents.enumerated() {
        var best = similarity(String(doc.title.prefix(320))), position = 0, offset = 0
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = doc.text
        var remaining = 64
        var offsetIndex = doc.text.startIndex
        tokenizer.enumerateTokens(in: doc.text.startIndex..<doc.text.endIndex) { range, _ in
            // Bound work per document and store offsets in UTF-16 for the renderer.
            let score = similarity(String(doc.text[range].prefix(320)))
            if score > best {
                best = score
                position = offset + doc.text[offsetIndex..<range.lowerBound].utf16.count
            }
            offset += doc.text[offsetIndex..<range.upperBound].utf16.count
            offsetIndex = range.upperBound
            remaining -= 1
            return remaining > 0
        }
        if best >= 0.4 { matches.append(Match(index: index, offset: position, score: min(1, best))) }
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(matches))
} catch { exit(2) }
