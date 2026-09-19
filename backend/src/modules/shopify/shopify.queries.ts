// GraphQL documents for the Shopify -> CRM sync. Queries only; nothing here can change Shopify data.

// Proves the token works and lists the access scopes it was granted.
export const CONNECTION_QUERY = /* GraphQL */ `
  query ConnectionCheck {
    shop {
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

// ---- Listing: light references only, so a page is cheap and unchanged records can be skipped ----
// The caller picks the sort. A backfill walks oldest-first by creation time, which never changes, so records
// created or edited while the walk is running can not shift a page boundary and hide a record.

export const ORDER_REFS_QUERY = /* GraphQL */ `
  query OrderRefs($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!, $reverse: Boolean) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        updatedAt
      }
    }
  }
`;

export const PRODUCT_REFS_QUERY = /* GraphQL */ `
  query ProductRefs($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys!, $reverse: Boolean) {
    products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        updatedAt
      }
    }
  }
`;

export const CUSTOMER_REFS_QUERY = /* GraphQL */ `
  query CustomerRefs($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys!, $reverse: Boolean) {
    customers(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        updatedAt
      }
    }
  }
`;

// ---- Counts: how many records match a search, without reading them. `limit: null` asks for the exact number. ----

export type CountField = "orders" | "products" | "customers";

export const countQuery = (field: CountField) => /* GraphQL */ `
  query Count($query: String) {
    result: ${field}Count(query: $query, limit: null) {
      count
      precision
    }
  }
`;

// ---- Full records, fetched one at a time by id (also what the webhook path uses) ----

export const ORDER_BY_ID_QUERY = /* GraphQL */ `
  fragment Money on MoneyBag {
    shopMoney {
      amount
      currencyCode
    }
  }

  query OrderById($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      updatedAt
      processedAt
      cancelledAt
      cancelReason
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      returnStatus
      taxesIncluded
      tags
      paymentGatewayNames
      discountCodes
      email
      phone
      customer {
        id
        firstName
        lastName
        email
        phone
      }
      shippingAddress {
        name
        firstName
        lastName
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
      }
      subtotalPriceSet {
        ...Money
      }
      totalDiscountsSet {
        ...Money
      }
      totalTaxSet {
        ...Money
      }
      totalShippingPriceSet {
        ...Money
      }
      totalPriceSet {
        ...Money
      }
      totalRefundedSet {
        ...Money
      }
      lineItems(first: 100) {
        pageInfo {
          hasNextPage
        }
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          originalUnitPriceSet {
            ...Money
          }
          discountAllocations {
            allocatedAmountSet {
              ...Money
            }
          }
          taxLines {
            priceSet {
              ...Money
            }
          }
          product {
            id
          }
          variant {
            id
          }
        }
      }
      transactions(first: 25) {
        id
        kind
        status
        gateway
        processedAt
        errorCode
        paymentId
        amountSet {
          ...Money
        }
        parentTransaction {
          id
        }
      }
      fulfillments(first: 10) {
        id
        status
        displayStatus
        createdAt
        deliveredAt
        trackingInfo {
          company
          number
          url
        }
      }
    }
  }
`;

export const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  query ProductById($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      vendor
      productType
      description
      createdAt
      updatedAt
      variants(first: 100) {
        pageInfo {
          hasNextPage
        }
        nodes {
          id
          title
          sku
          price
          updatedAt
        }
      }
    }
  }
`;

export const CUSTOMER_BY_ID_QUERY = /* GraphQL */ `
  query CustomerById($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      email
      phone
      createdAt
      updatedAt
      defaultAddress {
        city
        province
        zip
      }
    }
  }
`;
