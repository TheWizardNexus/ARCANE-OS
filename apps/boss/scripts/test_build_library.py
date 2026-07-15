from pathlib import Path
import unittest

from apps.boss.scripts.build_library import extract_source


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPOSITORY_ROOT / "test" / "fixtures"


class XmlExtractionTests(unittest.TestCase):
    def test_extracts_safe_xml_as_searchable_text(self):
        extraction = extract_source(
            FIXTURES / "boss-business-record.xml",
            "fixture.xml",
        )

        self.assertEqual(extraction.status, "complete")
        self.assertIn("Veteran Business Mentoring", extraction.text)
        self.assertIn("Request confidential mentoring", extraction.text)
        self.assertIn("https://www.score.org/find-mentor", extraction.links)
        self.assertIn("mentor@example.org", extraction.contacts)
        self.assertEqual(extraction.title_candidates[0][0], "Veteran Business Mentoring")

    def test_rejects_doctype_and_entity_declarations(self):
        extraction = extract_source(
            FIXTURES / "boss-unsafe-entity.xml",
            "unsafe.xml",
        )

        self.assertEqual(extraction.status, "failed")
        self.assertIn("DOCTYPE and ENTITY declarations are not supported", extraction.limitations)
        self.assertNotIn("private/local/file", extraction.text)


if __name__ == "__main__":
    unittest.main()
