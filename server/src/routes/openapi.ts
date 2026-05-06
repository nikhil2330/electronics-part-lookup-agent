import { Router, type IRouter, type Request } from "express";

const router: IRouter = Router();

function originFromRequest(req: Request): string {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get("host")}`;
}

function jsonResponse(description = "Successful response") {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  };
}

router.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Electronics Part Lookup Agent API",
      version: "1.0.0",
      description:
        "Backend tools for electronics part lookup, supplier comparison, Lyzr chat, and datasheet question answering.",
    },
    servers: [
      {
        url: originFromRequest(req),
      },
    ],
    paths: {
      "/api/lookup-part": {
        post: {
          operationId: "lookupPart",
          summary: "Look up a part through Mouser.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    part_number: {
                      type: "string",
                      description: "Manufacturer or supplier part number.",
                    },
                    question: {
                      type: "string",
                      description: "Optional specific spec question to answer from supplier fields.",
                    },
                  },
                  required: ["part_number"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
      "/api/search-keyword": {
        post: {
          operationId: "searchKeyword",
          summary: "Search Mouser by keyword.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    keyword: {
                      type: "string",
                      description: "Keyword search phrase.",
                    },
                    records: {
                      type: "integer",
                      minimum: 1,
                      maximum: 50,
                      description: "Maximum number of records to request.",
                    },
                  },
                  required: ["keyword"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
      "/api/compare-parts": {
        post: {
          operationId: "compareParts",
          summary: "Compare multiple part numbers through Mouser.",
          description:
            "Looks up multiple part numbers and returns their best matches for side-by-side comparison. Use this for comparison requests or small BOM lists.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    parts: {
                      type: "array",
                      description: "List of electronic component part numbers to compare.",
                      minItems: 1,
                      maxItems: 5,
                      items: {
                        type: "string",
                        minLength: 1,
                      },
                    },
                  },
                  required: ["parts"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
      "/api/product-page-specs": {
        post: {
          operationId: "productPageSpecs",
          summary: "Fetch Mouser product-page specs for a part.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    part_number: {
                      type: "string",
                      description: "Part number to inspect.",
                    },
                    question: {
                      type: "string",
                      description: "Optional specific spec question.",
                    },
                  },
                  required: ["part_number"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
      "/api/digikey-search": {
        post: {
          operationId: "digikeySearch",
          summary: "Search DigiKey by keyword.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    keyword: {
                      type: "string",
                      description: "Keyword search phrase.",
                    },
                    records: {
                      type: "integer",
                      minimum: 1,
                      maximum: 50,
                    },
                  },
                  required: ["keyword"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
      "/api/digikey-lookup": {
        post: {
          operationId: "digikeyLookup",
          summary: "Look up a part through DigiKey.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    part_number: {
                      type: "string",
                      description: "DigiKey or manufacturer part number.",
                    },
                    question: {
                      type: "string",
                      description: "Optional specific spec question to answer from DigiKey fields.",
                    },
                  },
                  required: ["part_number"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
      "/api/datasheet-answer": {
        post: {
          operationId: "datasheetAnswer",
          summary: "Answer a spec question using datasheet PDF text.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    datasheet_url: {
                      type: "string",
                      format: "uri",
                      description: "HTTP or HTTPS URL to a PDF datasheet.",
                    },
                    question: {
                      type: "string",
                      description: "Question to answer using only the datasheet text.",
                    },
                  },
                  required: ["datasheet_url", "question"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": jsonResponse(),
          },
        },
      },
    },
  });
});

export default router;
