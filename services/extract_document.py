"""Bounded text extraction only: never execute macros, scripts, or formulae."""
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

LIMIT = 12000
XML_LIMIT = 12 * 1024 * 1024
TOTAL_XML_LIMIT = 25 * 1024 * 1024


class DocumentError(Exception):
    pass


class Collector:
    def __init__(self):
        self.parts = []
        self.length = 0
        self.truncated = False

    def add(self, text):
        if not text:
            return True
        text = str(text)
        remaining = LIMIT + 1 - self.length
        if remaining <= 0:
            self.truncated = True
            return False
        self.parts.append(text[:remaining])
        self.length += min(len(text), remaining)
        if len(text) > remaining or self.length > LIMIT:
            self.truncated = True
            return False
        return True

    def result(self, warning=""):
        return {"ok": True, "text": "".join(self.parts), "truncated": self.truncated, "warning": warning}


def safe_zip(file):
    archive = zipfile.ZipFile(file)
    entries = archive.infolist()
    if len(entries) > 2000 or sum(item.file_size for item in entries) > TOTAL_XML_LIMIT:
        archive.close()
        raise DocumentError("DOCUMENT_UNSAFE")
    if any(item.flag_bits & 1 or item.file_size > XML_LIMIT or (item.file_size > 1024 * 1024 and item.file_size > max(1, item.compress_size) * 250) for item in entries):
        archive.close()
        raise DocumentError("DOCUMENT_UNSAFE")
    return archive


def xml(archive, name):
    item = archive.getinfo(name)
    if item.file_size > XML_LIMIT:
        raise DocumentError("DOCUMENT_UNSAFE")
    data = archive.read(item)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise DocumentError("DOCUMENT_UNSAFE")
    return ET.fromstring(data)


def word(file):
    collected = Collector()
    with safe_zip(file) as archive:
        root = xml(archive, "word/document.xml")
        for paragraph in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
            text = "".join(node.text or "" for node in paragraph.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
            if not collected.add(text + "\n"):
                break
    return collected.result("Word 본문의 텍스트만 읽었습니다. 이미지·도형·머리글·각주 등은 포함되지 않을 수 있습니다.")


def excel(file):
    collected = Collector()
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with safe_zip(file) as archive:
        names = archive.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            for item in xml(archive, "xl/sharedStrings.xml").findall(ns + "si"):
                shared.append("".join(node.text or "" for node in item.iter(ns + "t")))
        sheets = [name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
        if len(sheets) > 40:
            collected.truncated = True
        for name in sheets[:40]:
            if not collected.add("\n[" + name.rsplit("/", 1)[-1] + "]\n"):
                break
            root = xml(archive, name)
            stop = False
            for row in root.iter(ns + "row"):
                values = []
                for cell in row.findall(ns + "c"):
                    value = cell.find(ns + "v")
                    text = value.text or "" if value is not None else ""
                    if cell.get("t") == "s":
                        try:
                            text = shared[int(text)]
                        except (ValueError, IndexError):
                            text = ""
                    elif cell.get("t") == "inlineStr":
                        text = "".join(node.text or "" for node in cell.iter(ns + "t"))
                    if cell.find(ns + "f") is not None and not text:
                        text = "[계산 결과 미저장]"
                    values.append(cell.get("r", "") + ": " + text)
                if not collected.add("\t".join(values) + "\n"):
                    stop = True
                    break
            if stop:
                break
    return collected.result("Excel 셀의 저장된 값만 읽었습니다. 수식·매크로·외부 연결은 실행하지 않았으며 이미지·차트와 서식은 분석하지 않았습니다.")


def pdf(file):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise DocumentError("PDF_LIBRARY_REQUIRED") from None
    collected = Collector()
    reader = PdfReader(file)
    if reader.is_encrypted:
        raise DocumentError("PDF_ENCRYPTED")
    count = len(reader.pages)
    missing = 0
    extracted = False
    for index in range(min(count, 40)):
        page = reader.pages[index]
        # Bound decompressed page streams before invoking the text parser.
        contents = page.get_contents()
        if contents is not None and len(contents.get_data()) > XML_LIMIT:
            raise DocumentError("DOCUMENT_UNSAFE")
        text = page.extract_text() or ""
        if not text.strip():
            missing += 1
        else:
            extracted = True
        if not collected.add("\n[PDF " + str(index + 1) + "쪽]\n" + text):
            break
    if not extracted:
        raise DocumentError("PDF_OCR_REQUIRED")
    if count > 40:
        collected.truncated = True
    warnings = ["PDF의 텍스트만 읽었으며 이미지·표 배치는 원문과 다를 수 있습니다."]
    if count > 40:
        warnings.append("총 " + str(count) + "쪽 중 앞 40쪽까지만 읽었습니다.")
    if missing:
        warnings.append("읽은 페이지 중 " + str(missing) + "쪽은 텍스트가 없어 OCR이 필요할 수 있습니다.")
    return collected.result(" ".join(warnings))


def main():
    try:
        file = sys.argv[1]
        if not os.path.isfile(file) or os.path.getsize(file) > 5 * 1024 * 1024:
            raise DocumentError("DOCUMENT_UNSAFE")
        extension = os.path.splitext(file)[1].lower()
        extract = {".pdf": pdf, ".docx": word, ".xlsx": excel}.get(extension)
        if extract is None:
            raise DocumentError("UNSUPPORTED_DOCUMENT")
        result = extract(file)
    except DocumentError as error:
        result = {"ok": False, "code": str(error)}
    except Exception:
        result = {"ok": False, "code": "DOCUMENT_READ_FAILED"}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
