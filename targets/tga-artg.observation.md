# Observation: TGA — Australian Register of Therapeutic Goods (ARTG)

Ticket #9. Produced with observe mode (`observe: true`, or `observePage` from the source) against
`https://www.tga.gov.au/resources/artg` — the page the target `tga-artg-vitamin-d` starts on.

To reproduce the **query-page** dump: fetch that URL with `observe: true` and **no target matching it**
(point `targetsFile` somewhere else, or at nothing), because running the recipe navigates off the query page.
To reproduce the **results-page** dump: run the recipe (or search by hand) and observe
`…/artg?keywords=vitamin+d`. The `targetsFile` setting takes an absolute path — the plugin resolves it against
the host process's working directory, not this repository.

## What the page asks for

- One keyword field. Its only stable identities are its `aria-label` (`Search the ARTG keywords`),
  its placeholder (`Search the ARTG`) and its Drupal selector (`edit-keywords`); the input has **no id**
  that a recipe can rely on (the rendered `id` is `edit-keywords--2`).
- One submit, an icon-only Drupal submit with `aria-label="Search"` and
  `data-drupal-selector="edit-submit-search-2"`.
- The results are server-rendered into the same document: submitting navigated the same tab to
  `/resources/artg?keywords=vitamin+d` and produced `889 result(s) found, displaying 1 to 25`.
  **No frames, no popup, no key press** — the whole flow is inside what the action model can do.

## The live replay, measured

```
web_fetch https://www.tga.gov.au/resources/artg
Fetched https://www.tga.gov.au/resources/artg?keywords=vitamin+d (HTTP 200)
> actions: 1. waitFor text "Search medicines, medical devices and biologicals" — met
           · 2. type role textbox "Search the ARTG keywords" -> textbox (now "vitamin d") — met
           · 3. click selector "input[data-drupal-selector=\"edit-submit-search-2\"]" -> button — clicked
           · 4. waitFor text "889 result(s) found" — met
           → final document https://www.tga.gov.au/resources/artg?keywords=vitamin+d (HTTP 200)
```

The body that came back carries the searched view — `Medicines (846)`, `Medical devices (43)`, sponsor facets,
and the newest matching entries:

```
Swisse Ultiboost Vitamin C Gummies (531598)         23 September 2026
PREMIUM PROPOLIS 10000 VITAMIN C ZINC (531603)      23 September 2026
Provocatus Lightweight SPF 50 Sunscreen with Vita…  22 September 2026
Baby & Kids Vitamin D drops (531160)                11 September 2026
Qore8 Vitamin D3 (530897)                           3 September 2026
```

The keyword in the final URL is the site's own proof that it took the value (`type`'s read-back proves the
field held it; the site's own form proves what it did with it).

## The query page, as observe mode reported it

```
# Page state: Australian Register of Therapeutic Goods (ARTG) | Therapeutic Goods Administration (TGA)

URL: https://www.tga.gov.au/resources/artg
Counts: controls 338 (reachable 78), buttons 17, links 259, checkboxes 60 (unchecked 60), selects 0, forms 2, iframes 0

Visible text (head):
> Skip to main content Menu Search You are here Home Resources and guidance Australian Register of Therapeutic Goods (ARTG) Search medicines, medical devices and biologicals that can be supplied within Australia. You can search the ARTG by name, ID or sponsor. Search results include product name and formulation details, sponsor (company) and manufacturer details, Consumer Medicine Information (CMI) and Product Information (PI). Not all CMI and PI documents are available. Listen Print Share Use the filters below to narrow your search. Open all You can narrow down the results using the filters. Pr

## Controls (150 of 337; reachable first)
<!-- `Counts: controls 338` counts every control the page returned; this list is capped by
     OBSERVE_CONTROL_LIMIT (150) of `controlsTotal` (337), which is one lower because a control with no
     accessible name is counted but not listed. -->
1. [link] "Skip to main content"
2. [button] "Menu" - expanded=false
3. [button] "Search"
4. [link] "Home"
5. [link] "Resources and guidance"
6. [button] "Listen"
7. [button] "Print"
8. [button] "Share" - expanded=false
9. [button] "Open all"
10. [button] "Product type" - expanded=true
11. [checkbox] "Biologicals (50)" - unchecked
12. [checkbox] "Medical devices (62374)" - unchecked
13. [checkbox] "Medicines (34398)" - unchecked
14. [checkbox] "Other therapeutic goods (266)" - unchecked
15. [button] "Sponsor" - expanded=false
16. [button] "Published date" - expanded=false
17. [link] "ARTG search visualisation tool"
18. [text] "Search the ARTG keywords"
19. [submit] "Search"
20. [link] "Copy link to heading"
21. [link] "ArmaForce Stress & Immune Support (531593)"
22. [link] "CELLDEMIC H5N1 Pre-pandemic Influenza Vaccine (surface antig"
23. [link] "Clifford Hallam Healthcare Pty Ltd t/a Paragon Care Australi"
24. [link] "COLES COLD & FLU DAY & NIGHT soft gel capsules (new formula)"
25. [link] "ConvaTec Australia Pty Ltd - Urethral catheter, drainage, si"
26. [link] "Daily Ritual (531640)"
27. [link] "DAPAGLIFLOZIN GH dapagliflozin (as propanediol monohydrate) "
28. [link] "DAPAGLIFLOZIN LUPIN dapagliflozin (as propanediol monohydrat"
29. [link] "Device Technologies Australia Pty Ltd - AViD Dual Stage Veno"
30. [link] "Device Technologies Australia Pty Ltd - Thin-Flex Dual Stage"
31. [link] "Device Technologies Australia Pty Ltd - Trim-Flex Dual Stage"
32. [link] "DiaSorin Australia Pty Ltd - Clinical chemistry autoimmune I"
33. [link] "Emergo Asia Pacific Pty Ltd T/a Emergo Australia - Assisted "
34. [link] "Emergo Asia Pacific Pty Ltd T/a Emergo Australia - Erisma® S"
35. [link] "Endomed Pty Ltd - Specimen receptacle IVDs (531604)"
36. [link] "Enovis Surgical Australia Pty Ltd - EMPOWR 3D Knee Femur Non"
37. [link] "Enovis Surgical Australia Pty Ltd - EMPOWR 3D Knee Tibial In"
38. [link] "Enovis Surgical Australia Pty Ltd - Empowr Knee Finned Basep"
39. [link] "Enovis Surgical Australia Pty Ltd - Patella, Domed Tri-Peg, "
40. [link] "Hair Biotic (531601)"
41. [link] "HAWAIIAN ASTAXANTHIN DOUBLE STRENGTH (531602)"
42. [link] "Jensen Instrument Technologies - Knife handle (531595)"
43. [link] "Jensen Instrument Technologies - Mirror, dental, hand-held ("
44. [link] "KCI Medical Australia Pty Ltd - Holder, tube, nasogastric (5"
45. [link] "KCI Medical Australia Pty Ltd - Intravenous catheter holder "
46. [link] "Copy link to heading"
47. [link] "Page 2"
48. [link] "Page 3"
49. [link] "Page 4"
50. [link] "Page 5"
51. [link] "Page 6"
52. [link] "Page 7"
53. [link] "Page 8"
54. [link] "Page 9"
55. [link] "Next page Next ›"
56. [link] "Last page Last »"
57. [link] "Accessibility"
58. [link] "Privacy"
59. [link] "Security"
60. [link] "Disclaimer"
61. [link] "Copyright"
62. [link] "Freedom of information"
63. [link] "Acronyms and glossary terms"
64. [link] "Search our databases"
65. [link] "Report a problem or side effect"
66. [link] "TGA Business Services"
67. [link] "Special Access Scheme"
68. [link] "Authorised Prescriber"
69. [link] "Office of Drug Control"
70. [link] "State and territory contacts"
71. [link] "Email subscriptions"
72. [link] "Contact us"
73. [link] "Facebook"
74. [link] "(formerly Twitter)"
75. [link] "Youtube"
76. [link] "Instagram"
77. [link] "LinkedIn"
78. [link] "Provide feedback"
79. [link] "News and events" (not visible)
80. [link] "Contact us" (not visible)
81. [link] "About us" (not visible)
82. [text] "Search keywords" - expanded=false (not visible)
83. [submit] "Search" (not visible)
84. [button] "Go back" (not visible)
85. [button] "Close menu" (not visible)
86. [link] "Home" (not visible)
87. [link] "Product regulation" - expanded=false (not visible)
88. [link] "Product regulation" (not visible)
89. [link] "Quick links" (not visible)
90. [link] "Quick links" (not visible)
91. [link] "Search our product register (ARTG)" (not visible)
92. [link] "What's new" (not visible)
93. [link] "Regulation essentials" (not visible)
94. [link] "Regulations for all products" (not visible)
95. [link] "Regulations for all products" (not visible)
96. [link] "Legislation and legislative instruments" (not visible)
97. [link] "Ingredients and the scheduling of medicines and chemicals" (not visible)
98. [link] "Manufacturing" (not visible)
99. [link] "Application and market authorisation" (not visible)
100. [link] "Labelling and packaging" (not visible)
101. [link] "Advertising" (not visible)
102. [link] "Import and export" (not visible)
103. [link] "Compliance and enforcement" (not visible)
104. [link] "Access pathways including clinical trials" (not visible)
105. [link] "Biologicals" (not visible)
106. [link] "Biologicals" (not visible)
107. [link] "Faecal microbiota transplant (FMT)" (not visible)
108. [link] "Human cell and tissue (HCT)" (not visible)
109. [link] "Medical devices" (not visible)
110. [link] "Medical devices" (not visible)
111. [link] "Implantable devices" (not visible)
112. [link] "In vitro diagnostic (IVD) devices" (not visible)
113. [link] "Personal protective equipment (PPE)" (not visible)
114. [link] "Personalised medical devices" (not visible)
115. [link] "Software and artificial intelligence (AI)" (not visible)
116. [link] "System and procedure packs" (not visible)
117. [link] "Medicines" (not visible)
118. [link] "Medicines" (not visible)
119. [link] "Assessed listed medicines" (not visible)
120. [link] "Listed medicines" (not visible)
121. [link] "Over-the-counter (OTC) medicines" (not visible)
122. [link] "Prescription medicines" (not visible)
123. [link] "Registered complementary medicines" (not visible)
124. [link] "Therapeutic sunscreens" (not visible)
125. [link] "Other therapeutic goods" (not visible)
126. [link] "Other therapeutic goods" (not visible)
127. [link] "Disinfectants and sterilants" (not visible)
128. [link] "Tampons and menstrual cups" (not visible)
129. [link] "Unapproved therapeutic goods" (not visible)
130. [link] "Unapproved therapeutic goods" (not visible)
131. [link] "MDMA and psilocybine" (not visible)
132. [link] "Medicinal cannabis" (not visible)
133. [link] "Therapeutic vaping goods" (not visible)
134. [link] "Boundary and combination products" (not visible)
135. [link] "Safety and shortages" - expanded=false (not visible)
136. [link] "Safety and shortages" (not visible)
137. [link] "Report a problem" (not visible)
138. [link] "Report a problem" (not visible)
139. [link] "Report an adverse event or safety problem" (not visible)
140. [link] "Report a breach" (not visible)
141. [link] "Report a medicine shortage for industry" (not visible)
142. [link] "Manage a medical device supply disruption" (not visible)
143. [link] "Safety monitoring and information" (not visible)
144. [link] "Safety monitoring and information" (not visible)
145. [link] "Safety alerts" (not visible)
146. [link] "Safety updates" (not visible)
147. [link] "Shortages and supply disruptions" (not visible)
148. [link] "Shortages and supply disruptions" (not visible)
149. [link] "Medicine shortages" (not visible)
150. [link] "Medicine shortage alerts" (not visible)
```

## The results page, as observe mode reported it

```
# Page state: Australian Register of Therapeutic Goods (ARTG) | Therapeutic Goods Administration (TGA)

URL: https://www.tga.gov.au/resources/artg?keywords=vitamin+d
Counts: controls 326 (reachable 76), buttons 17, links 253, checkboxes 54 (unchecked 54), selects 0, forms 2, iframes 0

Visible text (head):
> Skip to main content Menu Search You are here Home Resources and guidance Australian Register of Therapeutic Goods (ARTG) Search medicines, medical devices and biologicals that can be supplied within Australia. You can search the ARTG by name, ID or sponsor. Search results include product name and formulation details, sponsor (company) and manufacturer details, Consumer Medicine Information (CMI) and Product Information (PI). Not all CMI and PI documents are available. Listen Print Share Use the filters below to narrow your search. Open all You can narrow down the results using the filters. Pr

## Controls (150 of 325; reachable first)
<!-- Same split as the query page: 326 counted, 325 named, 150 listed. -->
1. [link] "Skip to main content"
2. [button] "Menu" - expanded=false
3. [button] "Search"
4. [link] "Home"
5. [link] "Resources and guidance"
6. [button] "Listen"
7. [button] "Print"
8. [button] "Share" - expanded=false
9. [button] "Open all"
10. [button] "Product type" - expanded=true
11. [checkbox] "Medical devices (43)" - unchecked
12. [checkbox] "Medicines (846)" - unchecked
13. [button] "Sponsor" - expanded=false
14. [button] "Published date" - expanded=false
15. [link] "ARTG search visualisation tool"
16. [text] "Search the ARTG keywords"
17. [submit] "Search"
18. [link] "Copy link to heading"
19. [link] "Swisse Ultiboost Vitamin C Gummies (531598)"
20. [link] "PREMIUM PROPOLIS 10000 VITAMIN C ZINC (531603)"
21. [link] "Provocatus Lightweight SPF 50 Sunscreen with Vitamin E (5315"
22. [link] "Baby & Kids Vitamin D drops (531160)"
23. [link] "NutriVital Vitamin K2 (530958)"
24. [link] "Qore8 Vitamin D3 (530897)"
25. [link] "Qore8 Iron with Vitamin C (530898)"
26. [link] "Qore8 Calcium, Vitamin D3 & K2 (530896)"
27. [link] "BIOLOGICAL THERAPIES VITAMIN D3 300,000 IU IN 1 mL INJECTION"
28. [link] "BIOLOGICAL THERAPIES VITAMIN D3 600,000 IU IN 1 mL INJECTION"
29. [link] "Bioglan Vitamin K2 + D3 + Magnesium Glycinate (530462)"
30. [link] "Essential Vitamin & Mineral Complex (530499)"
31. [link] "Brauer Kids Liquid Vitamin C (530310)"
32. [link] "Healthcarebear Cellular Energy Vitamin B3 + Gummies (530270)"
33. [link] "Liposomal Vitamin C (529852)"
34. [link] "A-WON Vitamin K2 + D3 Soft Capsule (529734)"
35. [link] "A-WON Vitamin B3 500mg Tablet (529674)"
36. [link] "A-WON Opaque Vitamin D3 1000 IU Soft Capsule. (529736)"
37. [link] "A-WON Vitamin B12 100mcg Tablet (529678)"
38. [link] "Novomins Nutrition Kids Calcium & Vitamin D Gummies (529613)"
39. [link] "YouthRay Women's Health Multi Vitamin (529298)"
40. [link] "VITAMIN C THRESHOLD CONTROLLED TABLET (529059)"
41. [link] "Wagner Calcium + Vitamin D (528858)"
42. [link] "A-WON Vitamin D3 1000IU Liquid (528899)"
43. [link] "Vitamin A+D+E (528702)"
44. [link] "Copy link to heading"
45. [link] "Page 2"
46. [link] "Page 3"
47. [link] "Page 4"
48. [link] "Page 5"
49. [link] "Page 6"
50. [link] "Page 7"
51. [link] "Page 8"
52. [link] "Page 9"
53. [link] "Next page Next ›"
54. [link] "Last page Last »"
55. [link] "Accessibility"
56. [link] "Privacy"
57. [link] "Security"
58. [link] "Disclaimer"
59. [link] "Copyright"
60. [link] "Freedom of information"
61. [link] "Acronyms and glossary terms"
62. [link] "Search our databases"
63. [link] "Report a problem or side effect"
64. [link] "TGA Business Services"
65. [link] "Special Access Scheme"
66. [link] "Authorised Prescriber"
67. [link] "Office of Drug Control"
68. [link] "State and territory contacts"
69. [link] "Email subscriptions"
70. [link] "Contact us"
71. [link] "Facebook"
72. [link] "(formerly Twitter)"
73. [link] "Youtube"
74. [link] "Instagram"
75. [link] "LinkedIn"
76. [link] "Provide feedback"
77. [link] "News and events" (not visible)
78. [link] "Contact us" (not visible)
79. [link] "About us" (not visible)
80. [text] "Search keywords" - expanded=false (not visible)
81. [submit] "Search" (not visible)
82. [button] "Go back" (not visible)
83. [button] "Close menu" (not visible)
84. [link] "Home" (not visible)
85. [link] "Product regulation" - expanded=false (not visible)
86. [link] "Product regulation" (not visible)
87. [link] "Quick links" (not visible)
88. [link] "Quick links" (not visible)
89. [link] "Search our product register (ARTG)" (not visible)
90. [link] "What's new" (not visible)
91. [link] "Regulation essentials" (not visible)
92. [link] "Regulations for all products" (not visible)
93. [link] "Regulations for all products" (not visible)
94. [link] "Legislation and legislative instruments" (not visible)
95. [link] "Ingredients and the scheduling of medicines and chemicals" (not visible)
96. [link] "Manufacturing" (not visible)
97. [link] "Application and market authorisation" (not visible)
98. [link] "Labelling and packaging" (not visible)
99. [link] "Advertising" (not visible)
100. [link] "Import and export" (not visible)
101. [link] "Compliance and enforcement" (not visible)
102. [link] "Access pathways including clinical trials" (not visible)
103. [link] "Biologicals" (not visible)
104. [link] "Biologicals" (not visible)
105. [link] "Faecal microbiota transplant (FMT)" (not visible)
106. [link] "Human cell and tissue (HCT)" (not visible)
107. [link] "Medical devices" (not visible)
108. [link] "Medical devices" (not visible)
109. [link] "Implantable devices" (not visible)
110. [link] "In vitro diagnostic (IVD) devices" (not visible)
111. [link] "Personal protective equipment (PPE)" (not visible)
112. [link] "Personalised medical devices" (not visible)
113. [link] "Software and artificial intelligence (AI)" (not visible)
114. [link] "System and procedure packs" (not visible)
115. [link] "Medicines" (not visible)
116. [link] "Medicines" (not visible)
117. [link] "Assessed listed medicines" (not visible)
118. [link] "Listed medicines" (not visible)
119. [link] "Over-the-counter (OTC) medicines" (not visible)
120. [link] "Prescription medicines" (not visible)
121. [link] "Registered complementary medicines" (not visible)
122. [link] "Therapeutic sunscreens" (not visible)
123. [link] "Other therapeutic goods" (not visible)
124. [link] "Other therapeutic goods" (not visible)
125. [link] "Disinfectants and sterilants" (not visible)
126. [link] "Tampons and menstrual cups" (not visible)
127. [link] "Unapproved therapeutic goods" (not visible)
128. [link] "Unapproved therapeutic goods" (not visible)
129. [link] "MDMA and psilocybine" (not visible)
130. [link] "Medicinal cannabis" (not visible)
131. [link] "Therapeutic vaping goods" (not visible)
132. [link] "Boundary and combination products" (not visible)
133. [link] "Safety and shortages" - expanded=false (not visible)
134. [link] "Safety and shortages" (not visible)
135. [link] "Report a problem" (not visible)
136. [link] "Report a problem" (not visible)
137. [link] "Report an adverse event or safety problem" (not visible)
138. [link] "Report a breach" (not visible)
139. [link] "Report a medicine shortage for industry" (not visible)
140. [link] "Manage a medical device supply disruption" (not visible)
141. [link] "Safety monitoring and information" (not visible)
142. [link] "Safety monitoring and information" (not visible)
143. [link] "Safety alerts" (not visible)
144. [link] "Safety updates" (not visible)
145. [link] "Shortages and supply disruptions" (not visible)
146. [link] "Shortages and supply disruptions" (not visible)
147. [link] "Medicine shortages" (not visible)
148. [link] "Medicine shortage alerts" (not visible)
149. [link] "Medical device supply disruptions" (not visible)
150. [link] "Recalls and other market actions" (not visible)
```

## What the recipe is, and why

- `waitFor` the page intro (`Search medicines, medical devices and biologicals`) so the recipe acts on the
  query page and not on whatever else that URL may serve.
- `type` into the field by **role + accessible name** first (`Search the ARTG keywords`), with the
  aria-label selector as the second candidate: the button and the field are the two things the page
  offers, and neither has an id worth freezing.
- `click` the Drupal submit selector first, because the page also has a *site-wide* search control whose
  accessible name is also `Search`. The selector names the ARTG form's own submit; the role candidate is a
  readable fallback that could name the site-wide search instead — and because the final wait names the
  searched count, that mistake fails loudly rather than passing quietly.
- `waitFor` the searched count, `889 result(s) found`.

### Why the last wait names a number

This page lists results **before** any query — it is a browsable register, whose unfiltered view runs to six
figures — so a wait for the phrase `result(s) found` alone is already true when the recipe starts: the click
would be reported `clicked (unverified)`, and a submit that silently failed would still pass, handing back the
**unfiltered** register as if it were the search. That is the silent-wrong-answer class this whole model
exists to remove, so the wait names the count the query produces.

The cost is real and accepted: **when the register changes, this step fails loudly and the number is updated**.
That is the trade this repository prefers (fail with the step that did not hold) over a step that cannot tell
a search from a browse. A different keyword needs a different count, and therefore a different target — the
fetch seam carries a URL and nothing else, so a keyword is part of the recipe, not a parameter.

## Other regulator query sites this ticket looked at (findings, not workarounds)

- **NMPA 数据查询** (`https://datasearch.nmpa.gov.cn/datasearch/home-index.html`, the Chinese regulator
  this ticket was written around): the query form works — the keyword reaches the site's own endpoint
  (`…/data/nmpadata/countNums?itemIds=…&searchValue=维生素D`, HTTP 200, `nums: 924` for 阿司匹林 in
  境内生产药品) — but the results are opened **in a new tab** (`/datasearch/search-result.html`), and the
  plugin's single-tab scope closes what an action spawns. The result table is therefore out of reach for
  a `web_fetch`, and following a popup the action opened needs its own capability (and its own ticket).
- **Drugs@FDA** (`https://www.accessdata.fda.gov/scripts/cder/daf/`): the form submits in the same tab
  (no popup), and the result document is a **shell whose table arrives inside an `<iframe>`** —
  `iframes: 1`, no readable body. Frames are explicitly out of scope, so this is reported rather than
  worked around.
- Neither needed a key press; both are single-step forms.
