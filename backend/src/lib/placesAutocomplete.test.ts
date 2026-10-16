import test from "node:test";
import assert from "node:assert/strict";
import { mapPlace } from "./placesAutocomplete.js";

test("maps Place Details components into the form's fields", () => {
  const a = mapPlace({
    displayName: { text: "Bangalore Palace" },
    types: ["tourist_attraction", "point_of_interest", "establishment"],
    formattedAddress: "Palace Rd, Bengaluru 560052",
    addressComponents: [
      { longText: "Palace Road", types: ["route"] },
      { longText: "Vasanth Nagar", types: ["sublocality_level_1", "sublocality", "political"] },
      { longText: "Bengaluru", types: ["locality", "political"] },
      { longText: "Karnataka", types: ["administrative_area_level_1", "political"] },
      { longText: "560 052", types: ["postal_code"] },
    ],
  });
  assert.deepEqual([a.building, a.street, a.area, a.city, a.state, a.pincode, a.houseNumber], ["Bangalore Palace", "Palace Road", "Vasanth Nagar", "Bengaluru", "Karnataka", "560052", ""]);
});

test("street number + subpremise become the house number; premise is the building", () => {
  const a = mapPlace({ addressComponents: [{ longText: "4B", types: ["subpremise"] }, { longText: "12", types: ["street_number"] }, { longText: "Sunrise Apts", types: ["premise"] }] });
  assert.deepEqual([a.houseNumber, a.building], ["4B, 12", "Sunrise Apts"]);
});
