from pathlib import Path
from xml.etree import ElementTree

HEADER = Path(__file__).resolve().parents[1] / "assets/wiek-browser-benchmark-header.svg"


def test_header_uses_owned_orange_to_white_background() -> None:
    root = ElementTree.parse(HEADER).getroot()
    gradient = root.find(".//*[@id='orange']")
    assert gradient is not None
    colors = [stop.attrib["stop-color"] for stop in gradient.findall("{*}stop")]
    assert colors[0] == "#f97316"
    assert colors[-1] == "#ffffff"
    assert root.find("{*}rect").attrib["fill"] == "url(#orange)"


def test_header_has_white_letter_and_indicator() -> None:
    root = ElementTree.parse(HEADER).getroot()
    assert root.find("{*}path").attrib["stroke"] == "#ffffff"
    indicator = root.find("{*}circle")
    assert indicator.attrib["fill"] == "#ffffff"
    assert float(indicator.attrib["cx"]) > 512
    assert float(indicator.attrib["cy"]) < 512
