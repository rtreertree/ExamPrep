import { Field } from "./ui";
import { Selector } from "./Selector";
import type { SortOrder } from "../../shared/listing";

export function ListOrdering<T extends string>({
  sort,
  order,
  options,
  alphabetical,
  onSort,
  onOrder,
}: {
  sort: T;
  order: SortOrder;
  options: readonly { value: T; label: string }[];
  alphabetical?: boolean;
  onSort: (value: T) => void;
  onOrder: (value: SortOrder) => void;
}) {
  return (
    <div className="list-ordering">
      <Field label="Arrangement">
        <Selector
          value={sort}
          options={options}
          onValueChange={(value) => {
            const option = options.find((item) => item.value === value);
            if (option) onSort(option.value);
          }}
        />
      </Field>
      {sort === "manual" ? null : (
        <Field label="Order">
          <Selector
            value={order}
            onValueChange={(value) => onOrder(value === "asc" ? "asc" : "desc")}
            options={[
              { value: "asc", label: alphabetical ? "A to Z" : "Oldest first" },
              {
                value: "desc",
                label: alphabetical ? "Z to A" : "Newest first",
              },
            ]}
          />
        </Field>
      )}
    </div>
  );
}
