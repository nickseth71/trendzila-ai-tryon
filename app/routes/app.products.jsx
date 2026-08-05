// Dashboard: /app/products
// Lists every product in the store with its image, lets the merchant
// search by title, and paginates through results using Shopify's
// cursor-based GraphQL pagination (not offset-based — Shopify's Admin
// API doesn't support skipping to an arbitrary page number, only
// "next batch after this cursor" / "previous batch before this cursor").

import { useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";

const PAGE_SIZE = 10;

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const searchTerm = url.searchParams.get("query") || "";
  const cursor = url.searchParams.get("cursor") || null;
  const direction =
    url.searchParams.get("direction") === "prev" ? "prev" : "next";

  // Shopify's search syntax: wrap the term so it matches partial titles.
  // Strip quotes/backslashes so a merchant typing them can't break the query.
  const sanitizedTerm = searchTerm.replace(/["\\]/g, "").trim();
  const searchQuery = sanitizedTerm ? `title:*${sanitizedTerm}*` : null;

  const variables = { query: searchQuery };
  if (direction === "prev" && cursor) {
    variables.last = PAGE_SIZE;
    variables.before = cursor;
  } else {
    variables.first = PAGE_SIZE;
    variables.after = cursor || undefined;
  }

  const response = await admin.graphql(
    `#graphql
    query DashboardProducts(
      $first: Int
      $after: String
      $last: Int
      $before: String
      $query: String
    ) {
      products(
        first: $first
        after: $after
        last: $last
        before: $before
        query: $query
        sortKey: TITLE
      ) {
        nodes {
          id
          title
          status
          totalInventory
          featuredImage {
            url
            altText
          }
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }`,
    { variables },
  );

  const { data } = await response.json();

  return {
    products: data.products.nodes,
    pageInfo: data.products.pageInfo,
    searchTerm,
  };
}

export default function ProductsDashboard() {
  const { products, pageInfo, searchTerm } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const tableRef = useRef(null);
  const searchFieldRef = useRef(null);
  const debounceRef = useRef(null);

  // Wire pagination via addEventListener rather than JSX onNextPage/
  // onPreviousPage props — the camelCase JSX event props are unreliable
  // on custom elements in some React versions, addEventListener always works.
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;

    function goNext() {
      const params = new URLSearchParams();
      if (searchTerm) params.set("query", searchTerm);
      params.set("direction", "next");
      params.set("cursor", pageInfo.endCursor);
      setSearchParams(params);
    }

    function goPrev() {
      const params = new URLSearchParams();
      if (searchTerm) params.set("query", searchTerm);
      params.set("direction", "prev");
      params.set("cursor", pageInfo.startCursor);
      setSearchParams(params);
    }

    table.addEventListener("nextpage", goNext);
    table.addEventListener("previouspage", goPrev);
    return () => {
      table.removeEventListener("nextpage", goNext);
      table.removeEventListener("previouspage", goPrev);
    };
  }, [pageInfo, searchTerm, setSearchParams]);

  // Debounced search-as-you-type, also wired via addEventListener for
  // the same custom-element reliability reason.
  useEffect(() => {
    const field = searchFieldRef.current;
    if (!field) return;

    function handleInput(event) {
      const value = event.target.value ?? "";
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        const params = new URLSearchParams();
        if (value) params.set("query", value);
        // A new search always starts back at page 1.
        setSearchParams(params);
      }, 400);
    }

    field.addEventListener("input", handleInput);
    return () => field.removeEventListener("input", handleInput);
  }, [setSearchParams]);

  const [searchDraft, setSearchDraft] = useState(searchTerm);
  useEffect(() => setSearchDraft(searchTerm), [searchTerm]);

  return (
    <s-page heading="Products">
      <s-section padding="none" accessibilityLabel="Products table section">
        <s-table
          ref={tableRef}
          paginate
          hasNextPage={pageInfo.hasNextPage}
          hasPreviousPage={pageInfo.hasPreviousPage}
          loading={isLoading}
        >
          <s-search-field
            ref={searchFieldRef}
            slot="filters"
            label="Search products"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by product title"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
          />
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              Inventory
            </s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Price
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {products.map((product) => (
              <s-table-row key={product.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-clickable
                      href={`/app/products/${product.id.split("/").pop()}`}
                      accessibilityLabel={`${product.title} thumbnail`}
                      border="base"
                      borderRadius="base"
                      overflow="hidden"
                      inlineSize="40px"
                      blockSize="40px"
                    >
                      {product.featuredImage?.url ? (
                        <s-image
                          objectFit="cover"
                          alt={product.featuredImage.altText || product.title}
                          src={product.featuredImage.url}
                        />
                      ) : null}
                    </s-clickable>
                    <s-link
                      href={`/app/products/${product.id.split("/").pop()}`}
                    >
                      {product.title}
                    </s-link>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-badge
                    tone={product.status === "ACTIVE" ? "success" : "neutral"}
                  >
                    {product.status}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>{product.totalInventory}</s-table-cell>
                <s-table-cell>
                  {product.priceRangeV2.minVariantPrice.amount}{" "}
                  {product.priceRangeV2.minVariantPrice.currencyCode}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>

        {products.length === 0 && (
          <s-box padding="base">
            <s-paragraph>
              No products found{searchTerm ? ` for "${searchTerm}"` : ""}.
            </s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
